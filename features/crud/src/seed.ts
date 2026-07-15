import type { NormalizedEntity, NormalizedField } from "@backend-compiler/compiler";
import { names } from "@backend-compiler/target-nestjs-prisma";
import type { TargetRenderContext } from "@backend-compiler/target-sdk";

/**
 * Deterministic seed generation. The emitted `prisma/seed.ts` produces the
 * same rows on every machine and every run: ids are content-addressed, values
 * are index-derived, and every write is an upsert keyed by id, so re-running
 * the seed is a no-op instead of a duplicate.
 */

export interface SeedSettings {
  enabled: boolean;
  rowsPerEntity: number;
  organizations: number;
}

export function seedSettings(config: Record<string, unknown>): SeedSettings {
  const raw = (config.seed ?? {}) as Partial<SeedSettings>;
  return {
    enabled: raw.enabled ?? true,
    rowsPerEntity: raw.rowsPerEntity ?? 5,
    organizations: raw.organizations ?? 2,
  };
}

interface FeatureShape {
  auth: { userEntity: string; minPasswordLength: number } | null;
  organizations: { ownerRole: string; memberRole: string } | null;
  reservations: { entity: string; resource: string } | null;
}

function featureShape(context: TargetRenderContext): FeatureShape {
  const auth = context.featureConfig("auth") as
    | { userEntity?: string; minPasswordLength?: number }
    | undefined;
  const organizations = context.featureConfig("organizations") as
    | { roles?: string[]; defaultRole?: string }
    | undefined;
  const reservations = context.featureConfig("reservations") as
    | { entity?: string; resource?: string }
    | undefined;
  const orgRoles = organizations?.roles ?? ["owner", "admin", "member"];

  return {
    auth: auth
      ? {
          userEntity: auth.userEntity ?? "User",
          minPasswordLength: auth.minPasswordLength ?? 12,
        }
      : null,
    organizations: organizations
      ? {
          ownerRole: orgRoles[0] ?? "owner",
          memberRole: organizations.defaultRole ?? orgRoles[orgRoles.length - 1] ?? "member",
        }
      : null,
    reservations: reservations?.resource
      ? { entity: reservations.entity ?? "Reservation", resource: reservations.resource }
      : null,
  };
}

/** Fields the seed must supply: everything required without a database default. */
function seededFields(entity: NormalizedEntity): NormalizedField[] {
  return entity.fields.filter((field) => field.required && field.defaultValue === null);
}

/**
 * Stable creation order: parents before children along required owning
 * foreign keys inside the seeded set. Entities involved in a required-FK
 * cycle, or depending on an entity the seed cannot create, are excluded (the
 * emitted file documents each exclusion).
 */
function orderEntities(
  entities: readonly NormalizedEntity[],
  shape: FeatureShape,
): { ordered: NormalizedEntity[]; excluded: Array<{ entity: string; reason: string }> } {
  const seedable = new Map(entities.map((entity) => [entity.name, entity]));
  const external = new Set<string>();
  if (shape.auth) external.add(shape.auth.userEntity);
  if (shape.organizations) external.add("Organization");

  const excluded: Array<{ entity: string; reason: string }> = [];

  // Drop entities whose required parents can never exist, repeating until stable
  // because an exclusion can orphan further children.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entity of [...seedable.values()]) {
      const missing = entity.relations.find(
        (relation) =>
          relation.owner &&
          relation.foreignKey !== null &&
          relation.required &&
          !seedable.has(relation.target) &&
          !external.has(relation.target),
      );
      if (missing) {
        seedable.delete(entity.name);
        excluded.push({
          entity: entity.name,
          reason: `requires ${missing.target}, which this seed does not create`,
        });
        changed = true;
      }
    }
  }

  // Kahn's algorithm with alphabetical tie-breaking for determinism.
  const remaining = new Map(
    [...seedable.values()].map((entity) => [
      entity.name,
      new Set(
        entity.relations
          .filter(
            (relation) =>
              relation.owner &&
              relation.foreignKey !== null &&
              relation.required &&
              relation.target !== entity.name &&
              seedable.has(relation.target),
          )
          .map((relation) => relation.target),
      ),
    ]),
  );
  const ordered: NormalizedEntity[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, parents]) => parents.size === 0)
      .map(([name]) => name)
      .sort();

    if (ready.length === 0) {
      for (const name of [...remaining.keys()].sort()) {
        excluded.push({ entity: name, reason: "participates in a required-relation cycle" });
      }
      break;
    }

    for (const name of ready) {
      ordered.push(seedable.get(name)!);
      remaining.delete(name);
      for (const parents of remaining.values()) {
        parents.delete(name);
      }
    }
  }

  return { ordered, excluded };
}

/**
 * A deterministic TypeScript expression for one field value. `index` is the
 * row position inside its scope; `ordinal` is globally unique across the whole
 * seed run and is used wherever the column carries a unique constraint.
 */
function valueExpression(entity: NormalizedEntity, field: NormalizedField): string {
  const counter = field.unique ? "ordinal" : "index";

  if (field.enumValues && field.enumValues.length > 0) {
    if (field.enumValues.length === 1 || field.unique) {
      return `'${field.enumValues[0]}'`;
    }
    const literals = field.enumValues.map((value) => `'${value}'`).join(", ");
    return `([${literals}] as const)[${counter} % ${field.enumValues.length}]!`;
  }

  const min = field.constraints.minimum;
  const max = field.constraints.maximum;

  switch (field.type) {
    case "integer": {
      const base = min ?? 0;
      if (field.unique) return `${base} + ordinal`;
      const span = max !== null && max >= base ? Math.max(1, Math.floor(max - base) + 1) : 100;
      return `${base} + (index % ${span})`;
    }
    case "decimal": {
      const base = min ?? 0;
      if (field.unique) return `${base} + ordinal`;
      const span = max !== null && max > base ? max - base : 10;
      return `${base} + ((index % 10) * ${span}) / 10`;
    }
    case "boolean":
      return "index % 2 === 0";
    case "datetime":
    case "date":
      return `new Date(Date.UTC(2030, 0, 1) + ${counter} * 86_400_000)`;
    case "uuid":
      return `seededId('${entity.name}.${field.name}', ${counter})`;
    default: {
      const minLength = field.constraints.minLength ?? 1;
      const maxLength = field.constraints.maxLength ?? 64;
      return `seedString('${names.file(entity.name)}-${names.file(field.name)}', ${counter}, ${minLength}, ${maxLength})`;
    }
  }
}

/** Expression selecting the foreign-key value for a seeded row. */
function foreignKeyExpression(
  entity: NormalizedEntity,
  target: string,
  shape: FeatureShape,
  tenantScoped: boolean,
): string {
  if (shape.auth && target === shape.auth.userEntity) {
    return tenantScoped
      ? "membersByOrganization[organizationIndex]![index % 2]!"
      : "userIds[index % userIds.length]!";
  }
  if (shape.organizations && target === "Organization") {
    return tenantScoped ? "organizationId" : "organizationIds[0]!";
  }

  const variable = names.variable(target);
  // Parent rows created earlier in the ordered walk.
  return tenantScoped
    ? `${variable}IdsByOrganization[organizationId]![index % ${variable}IdsByOrganization[organizationId]!.length]!`
    : `${variable}Ids[index % ${variable}Ids.length]!`;
}

function entityBlock(
  entity: NormalizedEntity,
  shape: FeatureShape,
  usedAsParent: boolean,
): string {
  const variable = names.variable(entity.name);
  const delegate = names.delegate(entity.name);
  const tenantScoped = entity.tenant !== null && shape.organizations !== null;

  const assignments: string[] = ["        id,"];
  for (const field of seededFields(entity)) {
    assignments.push(`        ${field.name}: ${valueExpression(entity, field)},`);
  }

  for (const relation of entity.relations) {
    if (!relation.owner || relation.foreignKey === null || !relation.required) continue;
    if (relation.foreignKey === entity.tenant?.foreignKey && tenantScoped) {
      assignments.push("        organizationId,");
      continue;
    }
    if (relation.foreignKey === entity.ownership?.foreignKey && shape.auth) {
      assignments.push(
        `        ${relation.foreignKey}: ${foreignKeyExpression(entity, relation.target, shape, tenantScoped)},`,
      );
      continue;
    }
    assignments.push(
      `        ${relation.foreignKey}: ${foreignKeyExpression(entity, relation.target, shape, tenantScoped)},`,
    );
  }

  const collectors = usedAsParent
    ? tenantScoped
      ? `      ${variable}IdsByOrganization[organizationId]!.push(id);\n      ${variable}Ids.push(id);\n`
      : `      ${variable}Ids.push(id);\n`
    : "";

  const declaration = usedAsParent
    ? tenantScoped
      ? `  const ${variable}Ids: string[] = [];\n  const ${variable}IdsByOrganization: Record<string, string[]> = {};\n`
      : `  const ${variable}Ids: string[] = [];\n`
    : "";

  const scopeOpen = tenantScoped
    ? `  for (let organizationIndex = 0; organizationIndex < organizationIds.length; organizationIndex += 1) {
    const organizationId = organizationIds[organizationIndex]!;
${usedAsParent ? `    ${variable}IdsByOrganization[organizationId] = ${variable}IdsByOrganization[organizationId] ?? [];\n` : ""}    for (let index = 0; index < ROWS_PER_ENTITY; index += 1) {
      const ordinal = nextOrdinal();
      const id = seededId('${entity.name}', organizationId, index);`
    : `  {
    for (let index = 0; index < ROWS_PER_ENTITY; index += 1) {
      const ordinal = nextOrdinal();
      const id = seededId('${entity.name}', 'global', index);`;

  const scopeClose = tenantScoped ? "    }\n  }" : "    }\n  }";

  return `${declaration}${scopeOpen}
      void ordinal;
      await prisma.${delegate}.upsert({
        where: { id },
        update: {},
        create: {
${assignments.join("\n")}
        },
      });
${collectors}${scopeClose}
  summary['${entity.name}'] = ${tenantScoped ? "organizationIds.length * ROWS_PER_ENTITY" : "ROWS_PER_ENTITY"};
`;
}

export function renderSeedFile(context: TargetRenderContext): string | null {
  const config = seedSettings(context.config);
  if (!config.enabled) return null;

  const shape = featureShape(context);
  const { ordered, excluded } = orderEntities(context.crudEntities(), shape);
  if (ordered.length === 0 && !shape.auth) return null;

  const parentsInUse = new Set<string>();
  for (const entity of ordered) {
    for (const relation of entity.relations) {
      if (relation.owner && relation.foreignKey !== null && relation.required) {
        parentsInUse.add(relation.target);
      }
    }
  }
  if (shape.reservations) parentsInUse.add(shape.reservations.resource);

  const userEntity = shape.auth ? context.entity(shape.auth.userEntity) : null;
  const userDelegate = userEntity ? names.delegate(userEntity.name) : null;
  const extraUserFields = userEntity
    ? seededFields(userEntity).filter(
        (field) => !["email", "passwordHash"].includes(field.name),
      )
    : [];

  const passwordLength = Math.max(14, shape.auth?.minPasswordLength ?? 12);
  const seedPassword = "seed-password-".padEnd(passwordLength, "0");

  const exclusionNotes = excluded
    .map((item) => `// Not seeded: ${item.entity} — ${item.reason}.`)
    .join("\n");

  const userBlock = shape.auth
    ? `  // Development accounts. bcrypt cost 4 is acceptable only because these are
  // seed credentials for local development, never production accounts.
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 4);
  const userIds: string[] = [];
  for (let index = 0; index < USER_COUNT; index += 1) {
    const ordinal = nextOrdinal();
    void ordinal;
    const id = seededId('${userEntity!.name}', index);
    await prisma.${userDelegate}.upsert({
      where: { id },
      update: {},
      create: {
        id,
        email: 'seed-user-' + String(index) + '@example.test',
        passwordHash,
${extraUserFields.map((field) => `        ${field.name}: ${valueExpression(userEntity!, field)},`).join("\n")}
      },
    });
    userIds.push(id);
  }
  summary['${userEntity!.name}'] = USER_COUNT;
`
    : "";

  const organizationBlock = shape.organizations
    ? `  const organizationIds: string[] = [];
  const membersByOrganization: string[][] = [];
  for (let index = 0; index < SEED_ORGANIZATIONS; index += 1) {
    const id = seededId('Organization', index);
    await prisma.organization.upsert({
      where: { id },
      update: {},
      create: {
        id,
        name: seedString('seed-organization', index, 2, 120),
        slug: seedString('seed-organization', index, 2, 64),
      },
    });
    organizationIds.push(id);

    const owner = userIds[(index * 2) % userIds.length]!;
    const member = userIds[(index * 2 + 1) % userIds.length]!;
    membersByOrganization.push([owner, member]);

    await prisma.membership.upsert({
      where: { id: seededId('Membership', id, 'owner') },
      update: {},
      create: {
        id: seededId('Membership', id, 'owner'),
        organizationId: id,
        userId: owner,
        role: '${shape.organizations.ownerRole}' as never,
      },
    });
    if (member !== owner) {
      await prisma.membership.upsert({
        where: { id: seededId('Membership', id, 'member') },
        update: {},
        create: {
          id: seededId('Membership', id, 'member'),
          organizationId: id,
          userId: member,
          role: '${shape.organizations.memberRole}' as never,
        },
      });
    }
  }
  summary['Organization'] = SEED_ORGANIZATIONS;
  summary['Membership'] = SEED_ORGANIZATIONS * 2;
`
    : "";

  const entityBlocks = ordered
    .map((entity) => entityBlock(entity, shape, parentsInUse.has(entity.name)))
    .join("\n");

  const reservationBlock =
    shape.reservations && ordered.some((entity) => entity.name === shape.reservations!.resource)
      ? reservationSeedBlock(context, shape)
      : "";

  const userCount = shape.organizations
    ? `const USER_COUNT = SEED_ORGANIZATIONS * 2;`
    : `const USER_COUNT = 3;`;

  return `// Generated by backendgen. Deterministic development seed.
//
// Every id is derived from stable content, every write is an upsert, and no
// value depends on the clock or on randomness, so running this seed twice
// leaves the database byte-for-byte unchanged.
${exclusionNotes ? `${exclusionNotes}\n` : ""}import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
${shape.auth ? "import * as bcrypt from 'bcryptjs';\n" : ""}
const ROWS_PER_ENTITY = ${config.rowsPerEntity};
${shape.organizations ? `const SEED_ORGANIZATIONS = ${config.organizations};\n` : ""}${shape.auth ? `${userCount}\n\n/** Password for every seeded development account. */\nexport const SEED_PASSWORD = '${seedPassword}';\n` : ""}
/** Content-addressed id in UUID shape: identical inputs always produce the same row. */
function seededId(...parts: Array<string | number>): string {
  const digest = createHash('sha256').update(parts.join(':')).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    '4' + digest.slice(13, 16),
    '8' + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}

/** Deterministic string honouring the field's length constraints; the counter keeps unique columns unique. */
function seedString(prefix: string, counter: number, minLength: number, maxLength: number): string {
  const tag = counter.toString(36);
  if (maxLength <= tag.length) {
    return tag.slice(0, Math.max(1, maxLength));
  }

  // Initial length never exceeds maxLength, and the specification guarantees
  // minLength <= maxLength, so padding to minLength cannot overflow it.
  let value = prefix.slice(0, Math.max(1, maxLength - tag.length - 1)) + '-' + tag;
  while (value.length < minLength) {
    value += 'x';
  }
  return value;
}

let ordinalCounter = 0;
function nextOrdinal(): number {
  ordinalCounter += 1;
  return ordinalCounter;
}

export interface SeedSummary {
  rows: Record<string, number>;
}

export async function seedDatabase(prisma: PrismaClient): Promise<SeedSummary> {
  ordinalCounter = 0;
  const summary: Record<string, number> = {};

${userBlock}${organizationBlock}${entityBlocks}${reservationBlock}
  return { rows: summary };
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedDatabase(prisma)
    .then((result) => {
      for (const [entity, count] of Object.entries(result.rows)) {
        process.stdout.write(entity + ': ' + String(count) + ' row(s)\\n');
      }
    })
    .catch((error: unknown) => {
      process.exitCode = 1;
      console.error('Seed failed', error);
    })
    .finally(() => void prisma.$disconnect());
}
`;
}

function reservationSeedBlock(context: TargetRenderContext, shape: FeatureShape): string {
  const reservations = shape.reservations!;
  const reservation = context.entity(reservations.entity);
  const delegate = names.delegate(reservations.entity);
  const resourceVariable = names.variable(reservations.resource);
  const tenantScoped = reservation.tenant !== null && shape.organizations !== null;

  const scopeOpen = tenantScoped
    ? `  for (let organizationIndex = 0; organizationIndex < organizationIds.length; organizationIndex += 1) {
    const organizationId = organizationIds[organizationIndex]!;
    const resourceId = ${resourceVariable}IdsByOrganization[organizationId]![0]!;
    const ownerId = membersByOrganization[organizationIndex]![1]!;`
    : `  {
    const resourceId = ${resourceVariable}Ids[0]!;
    const ownerId = userIds[0]!;`;

  return `
  // Two confirmed, non-overlapping reservations per ${tenantScoped ? "tenant" : "project"}.
  // Sequential windows keep the database overlap constraint satisfied.
${scopeOpen}
    for (let index = 0; index < 2; index += 1) {
      const startsAt = new Date(Date.UTC(2031, 0, 1, 9 + index * 2));
      const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
      const id = seededId('${reservations.entity}', resourceId, index);
      await prisma.${delegate}.upsert({
        where: { id },
        update: {},
        create: {
          id,
          resourceId,
          ownerId,${tenantScoped ? "\n          organizationId," : ""}
          startsAt,
          endsAt,
          status: 'CONFIRMED' as never,
          confirmedAt: startsAt,
        },
      });
    }
  }
  summary['${reservations.entity}'] = ${tenantScoped ? "organizationIds.length * 2" : "2"};
`;
}

/** Integration test proving the seed is deterministic, idempotent and tenant-distributed. */
export function renderSeedTestFile(context: TargetRenderContext): string | null {
  const config = seedSettings(context.config);
  if (!config.enabled) return null;

  const shape = featureShape(context);
  const { ordered } = orderEntities(context.crudEntities(), shape);
  const probe = ordered[0];
  if (probe === undefined) return null;

  const probeDelegate = names.delegate(probe.name);
  const tenantScoped = probe.tenant !== null && shape.organizations !== null;

  return `import { seedDatabase } from '../prisma/seed';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { resetDatabase } from './utils/reset';
import { createTestApp } from './utils/test-app';
import { INestApplication } from '@nestjs/common';

describe('Seed (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('seeds deterministically and idempotently', async () => {
    const first = await seedDatabase(prisma);
    const snapshot = await prisma.${probeDelegate}.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    expect(snapshot.length).toBeGreaterThan(0);

    const second = await seedDatabase(prisma);
    expect(second.rows).toEqual(first.rows);

    const after = await prisma.${probeDelegate}.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(snapshot);
  });
${
    tenantScoped
      ? `
  it('distributes rows evenly across seeded organizations', async () => {
    await seedDatabase(prisma);

    const groups = await prisma.${probeDelegate}.groupBy({
      by: ['organizationId'],
      _count: { _all: true },
    });

    expect(groups.length).toBe(${config.organizations});
    for (const group of groups) {
      expect(group._count._all).toBe(${config.rowsPerEntity});
    }
  });
`
      : ""
  }});
`;
}
