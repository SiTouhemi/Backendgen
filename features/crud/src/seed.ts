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
  auth: {
    userEntity: string;
    minPasswordLength: number;
    adminRole: string;
    defaultRole: string;
  } | null;
  organizations: { ownerRole: string; memberRole: string } | null;
  reservations: { entity: string; resource: string } | null;
}

function featureShape(context: TargetRenderContext): FeatureShape {
  const auth = context.featureConfig("auth") as
    | {
        userEntity?: string;
        minPasswordLength?: number;
        roles?: string[];
        defaultRole?: string;
      }
    | undefined;
  const organizations = context.featureConfig("organizations") as
    | { roles?: string[]; defaultRole?: string }
    | undefined;
  const reservations = context.featureConfig("reservations") as
    | { entity?: string; resource?: string }
    | undefined;
  const orgRoles = organizations?.roles ?? ["owner", "admin", "member"];
  const accountRoles = auth?.roles ?? ["admin", "user"];
  const accountDefault = auth?.defaultRole ?? accountRoles.at(-1) ?? "user";

  return {
    auth: auth
      ? {
          userEntity: auth.userEntity ?? "User",
          minPasswordLength: auth.minPasswordLength ?? 12,
          adminRole:
            accountRoles.find((role) => role !== accountDefault) ?? accountRoles[0] ?? "admin",
          defaultRole: accountDefault,
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

interface UniqueDrivers {
  fields: Set<string>;
  relations: Set<string>;
  unsupported: string[];
}

/** Selects one deterministic uniqueness driver for every explicit unique index. */
function uniqueDrivers(entity: NormalizedEntity): UniqueDrivers {
  const fields = new Set<string>();
  const relations = new Set<string>();
  const unsupported: string[] = [];
  const fieldsByName = new Map(entity.fields.map((field) => [field.name, field] as const));
  const relationsByKey = new Map(
    entity.relations
      .filter((relation) => relation.owner && relation.foreignKey !== null)
      .map((relation) => [relation.foreignKey as string, relation] as const),
  );

  for (const index of entity.indexes.filter((candidate) => candidate.unique)) {
    if (index.fields.includes("id")) continue;
    if (
      index.fields.some((name) => fieldsByName.get(name)?.unique === true) ||
      index.fields.some((name) => relationsByKey.get(name)?.unique === true)
    ) {
      continue;
    }

    // PostgreSQL permits repeated NULLs in unique indexes. Optional members
    // without a default are omitted by the seed, so no extra driver is needed.
    if (
      index.fields.some((name) => {
        const field = fieldsByName.get(name);
        if (field !== undefined) return !field.required && field.defaultValue === null;
        const relation = relationsByKey.get(name);
        return relation !== undefined && !relation.required;
      })
    ) {
      continue;
    }

    const scalar = index.fields.find((name) => fieldsByName.has(name));
    if (scalar !== undefined) {
      fields.add(scalar);
      continue;
    }
    const relation = index.fields.find((name) => relationsByKey.has(name));
    if (relation !== undefined) {
      relations.add(relation);
      continue;
    }
    unsupported.push(index.fields.join(", "));
  }

  return { fields, relations, unsupported };
}

/** Required values plus deterministic drivers for every uniqueness constraint. */
function seededFields(
  entity: NormalizedEntity,
): Array<{ field: NormalizedField; unique: boolean }> {
  const drivers = uniqueDrivers(entity).fields;
  return entity.fields
    .filter(
      (field) =>
        (field.required && field.defaultValue === null) || field.unique || drivers.has(field.name),
    )
    .map((field) => ({ field, unique: field.unique || drivers.has(field.name) }));
}

function seededUserCount(shape: FeatureShape, settings: SeedSettings): number {
  return shape.organizations === null ? 3 : settings.organizations * 2;
}

function desiredEntityRows(
  entity: NormalizedEntity,
  shape: FeatureShape,
  settings: SeedSettings,
): number {
  return entity.tenant !== null && shape.organizations !== null
    ? settings.rowsPerEntity * settings.organizations
    : settings.rowsPerEntity;
}

function uniqueFieldCapacity(field: NormalizedField, unique: boolean): number | null {
  if (!unique) return null;
  if (field.enumValues !== null) return field.enumValues.length;

  if (field.type === "boolean") return 2;

  if (field.type === "integer" || field.type === "decimal") {
    const minimum = field.constraints.minimum;
    const maximum = field.constraints.maximum;
    if (minimum !== null && maximum !== null) {
      return Math.max(0, Math.floor(maximum - minimum) + 1);
    }
  }

  if (field.type === "string" || field.type === "text") {
    const maxLength = field.constraints.maxLength;
    if (maxLength !== null && maxLength <= 6) {
      return 36 ** maxLength - 1;
    }
  }

  return null;
}

function relationCapacity(
  target: NormalizedEntity | undefined,
  targetName: string,
  shape: FeatureShape,
  settings: SeedSettings,
): number {
  if (shape.auth !== null && targetName === shape.auth.userEntity) {
    return seededUserCount(shape, settings);
  }
  if (shape.organizations !== null && targetName === "Organization") {
    return settings.organizations;
  }
  if (target === undefined) return 0;

  return desiredEntityRows(target, shape, settings);
}

function unseedableReason(
  entity: NormalizedEntity,
  seedable: ReadonlyMap<string, NormalizedEntity>,
  shape: FeatureShape,
  settings: SeedSettings,
): string | null {
  const self = entity.relations.find(
    (relation) =>
      relation.owner &&
      relation.foreignKey !== null &&
      relation.required &&
      relation.target === entity.name,
  );
  if (self !== undefined) {
    return `requires itself through ${self.name}, so no first row can be inserted`;
  }

  const totalRows = desiredEntityRows(entity, shape, settings);
  const drivers = uniqueDrivers(entity);
  if (drivers.unsupported.length > 0) {
    return `unique index (${drivers.unsupported[0]}) has no seedable field`;
  }
  for (const plan of seededFields(entity)) {
    const capacity = uniqueFieldCapacity(plan.field, plan.unique);
    if (capacity !== null && capacity < totalRows) {
      return `unique field ${plan.field.name} has only ${capacity} deterministic value(s) for ${totalRows} rows`;
    }
  }

  for (const relation of entity.relations) {
    if (
      !relation.owner ||
      relation.foreignKey === null ||
      !relation.required ||
      !(relation.unique || drivers.relations.has(relation.foreignKey))
    ) {
      continue;
    }
    const capacity = relationCapacity(
      seedable.get(relation.target),
      relation.target,
      shape,
      settings,
    );
    if (capacity < totalRows) {
      return `unique relation ${relation.name} has ${capacity} parent row(s) for ${totalRows} child rows`;
    }
  }

  return null;
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
  settings: SeedSettings,
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
      const unsupported = unseedableReason(entity, seedable, shape, settings);
      if (unsupported !== null) {
        seedable.delete(entity.name);
        excluded.push({ entity: entity.name, reason: unsupported });
        changed = true;
        continue;
      }
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
function valueExpression(
  entity: NormalizedEntity,
  field: NormalizedField,
  uniqueRows: number,
  unique: boolean,
): string {
  const counter = unique ? "ordinal" : "index";

  if (field.enumValues && field.enumValues.length > 0) {
    if (field.enumValues.length === 1) {
      return `'${field.enumValues[0]}'`;
    }
    const literals = field.enumValues.map((value) => `'${value}'`).join(", ");
    const offset = unique ? `${counter} - 1` : counter;
    return `([${literals}] as const)[(${offset}) % ${field.enumValues.length}]!`;
  }

  const min = field.constraints.minimum;
  const max = field.constraints.maximum;

  switch (field.type) {
    case "integer": {
      const base = min ?? (max !== null ? Math.min(0, max - Math.max(0, uniqueRows - 1)) : 0);
      if (unique) return `${base} + (ordinal - 1)`;
      const span = max !== null && max >= base ? Math.max(1, Math.floor(max - base) + 1) : 100;
      return `${base} + (index % ${span})`;
    }
    case "decimal": {
      const base = min ?? (max !== null ? Math.min(0, max - Math.max(0, uniqueRows - 1)) : 0);
      if (unique) return `${base} + (ordinal - 1)`;
      const span = max !== null ? Math.max(0, max - base) : 10;
      return `${base} + ((index % 10) * ${span}) / 10`;
    }
    case "boolean":
      return unique ? "(ordinal - 1) % 2 === 0" : "index % 2 === 0";
    case "datetime":
    case "date":
      return `new Date(Date.UTC(2030, 0, 1) + (${unique ? `${counter} - 1` : counter}) * 86_400_000)`;
    case "uuid":
      return `seededId('${entity.name}.${field.name}', ${counter})`;
    default: {
      const minLength = field.constraints.minLength ?? 1;
      const maxLength = field.constraints.maxLength ?? 64;
      if (unique) {
        return `seedUniqueString(${counter}, ${minLength}, ${maxLength})`;
      }
      return `seedString('${names.file(entity.name)}-${names.file(field.name)}', ${counter}, ${minLength}, ${maxLength})`;
    }
  }
}

/** Expression selecting the foreign-key value for a seeded row. */
function foreignKeyExpression(
  target: string,
  targetEntity: NormalizedEntity | undefined,
  shape: FeatureShape,
  tenantScoped: boolean,
  unique: boolean,
): string {
  if (shape.auth && target === shape.auth.userEntity) {
    return tenantScoped
      ? "membersByOrganization[organizationIndex]![index % 2]!"
      : `userIds[${unique ? "(ordinal - 1)" : "index"} % userIds.length]!`;
  }
  if (shape.organizations && target === "Organization") {
    return tenantScoped
      ? "organizationId"
      : `organizationIds[${unique ? "(ordinal - 1)" : "index"} % organizationIds.length]!`;
  }

  const variable = names.variable(target);
  const targetTenantScoped =
    targetEntity !== undefined && targetEntity.tenant !== null && shape.organizations !== null;
  // Use the per-organization pool only when both sides are tenant-scoped.
  return tenantScoped && targetTenantScoped
    ? `${variable}IdsByOrganization[organizationId]![index % ${variable}IdsByOrganization[organizationId]!.length]!`
    : `${variable}Ids[${unique ? "(ordinal - 1)" : "index"} % ${variable}Ids.length]!`;
}

function entityBlock(
  entity: NormalizedEntity,
  shape: FeatureShape,
  usedAsParent: boolean,
  settings: SeedSettings,
  entitiesByName: ReadonlyMap<string, NormalizedEntity>,
): string {
  const variable = names.variable(entity.name);
  const delegate = names.delegate(entity.name);
  const tenantScoped = entity.tenant !== null && shape.organizations !== null;
  const totalRows = desiredEntityRows(entity, shape, settings);
  const drivers = uniqueDrivers(entity);

  const assignments: string[] = ["        id,"];
  for (const plan of seededFields(entity)) {
    assignments.push(
      `        ${plan.field.name}: ${valueExpression(entity, plan.field, totalRows, plan.unique)},`,
    );
  }

  for (const relation of entity.relations) {
    if (!relation.owner || relation.foreignKey === null || !relation.required) continue;
    if (relation.foreignKey === entity.tenant?.foreignKey && tenantScoped) {
      assignments.push("        organizationId,");
      continue;
    }
    if (relation.foreignKey === entity.ownership?.foreignKey && shape.auth) {
      assignments.push(
        `        ${relation.foreignKey}: ${foreignKeyExpression(relation.target, entitiesByName.get(relation.target), shape, tenantScoped, relation.unique || drivers.relations.has(relation.foreignKey))},`,
      );
      continue;
    }
    assignments.push(
      `        ${relation.foreignKey}: ${foreignKeyExpression(relation.target, entitiesByName.get(relation.target), shape, tenantScoped, relation.unique || drivers.relations.has(relation.foreignKey))},`,
    );
  }

  const collectors = usedAsParent
    ? tenantScoped
      ? `      ${variable}IdsByOrganization[organizationId]!.push(id);\n      ${variable}Ids.push(id);\n`
      : `      ${variable}Ids.push(id);\n`
    : "";

  const idDeclaration = usedAsParent
    ? tenantScoped
      ? `  const ${variable}Ids: string[] = [];\n  const ${variable}IdsByOrganization: Record<string, string[]> = {};\n`
      : `  const ${variable}Ids: string[] = [];\n`
    : "";
  const declaration = `${idDeclaration}  let ${variable}Ordinal = 0;\n`;

  const scopeOpen = tenantScoped
    ? `  for (let organizationIndex = 0; organizationIndex < organizationIds.length; organizationIndex += 1) {
    const organizationId = organizationIds[organizationIndex]!;
${usedAsParent ? `    ${variable}IdsByOrganization[organizationId] = ${variable}IdsByOrganization[organizationId] ?? [];\n` : ""}    for (let index = 0; index < ROWS_PER_ENTITY; index += 1) {
      const ordinal = ++${variable}Ordinal;
      const id = seededId('${entity.name}', organizationId, index);`
    : `  {
    for (let index = 0; index < ROWS_PER_ENTITY; index += 1) {
      const ordinal = ++${variable}Ordinal;
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

function authSeedUnsupportedReason(
  context: TargetRenderContext,
  shape: FeatureShape,
  settings: SeedSettings,
): string | null {
  if (shape.auth === null) return null;
  const user = context.entity(shape.auth.userEntity);
  const requiredRelation = user.relations.find(
    (relation) => relation.owner && relation.foreignKey !== null && relation.required,
  );
  if (requiredRelation !== undefined) {
    return `auth user requires relation ${requiredRelation.name}, which cannot be created before development accounts`;
  }

  const drivers = uniqueDrivers(user);
  if (drivers.unsupported.length > 0) {
    return `auth user unique index (${drivers.unsupported[0]}) has no seedable field`;
  }

  const rows = seededUserCount(shape, settings);
  for (const plan of seededFields(user)) {
    if (["email", "passwordHash", "role"].includes(plan.field.name)) continue;
    const capacity = uniqueFieldCapacity(plan.field, plan.unique);
    if (capacity !== null && capacity < rows) {
      return `auth user field ${plan.field.name} has ${capacity} deterministic value(s) for ${rows} accounts`;
    }
  }
  return null;
}

export function renderSeedFile(context: TargetRenderContext): string | null {
  const config = seedSettings(context.config);
  if (!config.enabled) return null;

  const shape = featureShape(context);
  if (authSeedUnsupportedReason(context, shape, config) !== null) return null;
  const { ordered, excluded } = orderEntities(context.crudEntities(), shape, config);
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
  const userRows = seededUserCount(shape, config);
  const extraUserFields = userEntity
    ? seededFields(userEntity).filter(
        (plan) => !["email", "passwordHash", "role"].includes(plan.field.name),
      )
    : [];

  const userRoleEnum = userEntity ? names.enumType(userEntity.name, "role") : null;
  const membershipRoleEnum = shape.organizations
    ? names.enumType("Membership", "role")
    : null;
  const reservationStatusEnum = shape.reservations
    ? names.enumType(shape.reservations.entity, "status")
    : null;
  const usesUniqueString =
    ordered.some((entity) =>
      seededFields(entity).some(
        (plan) =>
          plan.unique && (plan.field.type === "string" || plan.field.type === "text"),
      ),
    ) ||
    extraUserFields.some(
      (plan) => plan.unique && (plan.field.type === "string" || plan.field.type === "text"),
    );

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
    const ordinal = index + 1;
    void ordinal;
    const id = seededId('${userEntity!.name}', index);
    await prisma.${userDelegate}.upsert({
      where: { id },
      update: {},
      create: {
        id,
        email: 'seed-user-' + String(index) + '@example.test',
        passwordHash,
        role: index === 0
          ? ${userRoleEnum}.${shape.auth.adminRole}
          : ${userRoleEnum}.${shape.auth.defaultRole},
${extraUserFields.map((plan) => `        ${plan.field.name}: ${valueExpression(userEntity!, plan.field, userRows, plan.unique)},`).join("\n")}
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
        role: ${membershipRoleEnum}.${shape.organizations.ownerRole},
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
          role: ${membershipRoleEnum}.${shape.organizations.memberRole},
        },
      });
    }
  }
  summary['Organization'] = SEED_ORGANIZATIONS;
  summary['Membership'] = SEED_ORGANIZATIONS * 2;
`
    : "";

  const orderedByName = new Map(ordered.map((entity) => [entity.name, entity] as const));
  const entityBlocks = ordered
    .map((entity) =>
      entityBlock(
        entity,
        shape,
        parentsInUse.has(entity.name),
        config,
        orderedByName,
      ),
    )
    .join("\n");

  const reservationBlock =
    shape.reservations && ordered.some((entity) => entity.name === shape.reservations!.resource)
      ? reservationSeedBlock(context, shape)
      : "";

  const userCount = shape.organizations
    ? `const USER_COUNT = SEED_ORGANIZATIONS * 2;`
    : `const USER_COUNT = 3;`;
  const prismaImports = [
    "PrismaClient",
    userRoleEnum,
    membershipRoleEnum,
    reservationStatusEnum,
  ].filter((value): value is string => value !== null);

  return `// Generated by backendgen. Deterministic development seed.
//
// Every id is derived from stable content, every write is an upsert, and no
// value depends on the clock or on randomness, so running this seed twice
// leaves the database byte-for-byte unchanged.
${exclusionNotes ? `${exclusionNotes}\n` : ""}import { createHash } from 'node:crypto';
import { ${[...new Set(prismaImports)].join(", ")} } from '@prisma/client';
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

${usesUniqueString ? `/** Compact base-36 value for unique string columns, padded without truncating its unique suffix. */
function seedUniqueString(counter: number, minLength: number, maxLength: number): string {
  const tag = counter.toString(36);
  if (tag.length > maxLength) {
    throw new Error('Seed counter exceeds the capacity of a unique string field');
  }
  return tag.padStart(Math.min(minLength, maxLength), '0');
}
` : ""}

export interface SeedSummary {
  rows: Record<string, number>;
}

export async function seedDatabase(prisma: PrismaClient): Promise<SeedSummary> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_SEED !== 'true') {
    throw new Error(
      'Refusing to seed a production database. Set ALLOW_PRODUCTION_SEED=true only after verifying the target database.',
    );
  }
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
          status: ${names.enumType(reservations.entity, "status")}.CONFIRMED,
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
  if (authSeedUnsupportedReason(context, shape, config) !== null) return null;
  const { ordered } = orderEntities(context.crudEntities(), shape, config);
  const probe = ordered[0];
  if (probe === undefined) return null;

  const probeDelegate = names.delegate(probe.name);
  const tenantScoped = probe.tenant !== null && shape.organizations !== null;
  const userDelegate = shape.auth ? names.delegate(shape.auth.userEntity) : null;

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
    shape.auth
      ? `
  it('creates one privileged development account and least-privileged remaining accounts', async () => {
    await seedDatabase(prisma);
    const users = await prisma.${userDelegate}.findMany({
      orderBy: { email: 'asc' },
      select: { email: true, role: true },
    });

    expect(users[0]).toMatchObject({
      email: 'seed-user-0@example.test',
      role: '${shape.auth.adminRole}',
    });
    expect(users.slice(1).every((user) => user.role === '${shape.auth.defaultRole}')).toBe(true);
  });

  it('refuses production seeding without an explicit operator opt-in', async () => {
    const nodeEnvironment = process.env.NODE_ENV;
    const optIn = process.env.ALLOW_PRODUCTION_SEED;
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_PRODUCTION_SEED;
    try {
      await expect(seedDatabase(prisma)).rejects.toThrow('Refusing to seed a production database');
    } finally {
      if (nodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnvironment;
      if (optIn === undefined) delete process.env.ALLOW_PRODUCTION_SEED;
      else process.env.ALLOW_PRODUCTION_SEED = optIn;
    }
  });
`
      : ""
}
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
