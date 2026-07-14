import { compileSpec, normalizeEntities } from "@backend-compiler/compiler";
import type { BackendSpec } from "@backend-compiler/specification";
import { describe, expect, it } from "vitest";
import {
  databaseNames,
  derivedIndexes,
  POSTGRES_IDENTIFIER_MAX_BYTES,
  postgresIdentifier,
} from "./naming.js";
import { renderInitialMigration } from "./prisma-ddl.js";
import { renderPrismaSchema } from "./prisma-schema.js";

function renderingSpec(): BackendSpec {
  return {
    specVersion: "backendcompiler.dev/v1",
    project: { name: "prisma-rendering" },
    target: { id: "nestjs-prisma", database: "postgresql" },
    entities: {
      Organization: { fields: { name: { type: "string", required: true } } },
      User: { fields: { email: { type: "string", required: true, unique: true } } },
      Reservation: {
        fields: {
          idempotencyKey: "string",
          startsAt: { type: "datetime", required: true },
        },
        relations: [
          {
            name: "organization",
            type: "belongsTo",
            target: "Organization",
            required: true,
          },
          {
            name: "owner",
            type: "belongsTo",
            target: "User",
            required: true,
            onDelete: "cascade",
          },
          {
            name: "reviewer",
            type: "belongsTo",
            target: "User",
            onDelete: "setNull",
          },
        ],
        indexes: [
          {
            fields: ["organizationId", "ownerId", "idempotencyKey"],
            unique: true,
          },
        ],
      },
    },
    features: {},
  };
}

describe("Prisma schema and initial DDL rendering", () => {
  it("keeps referential actions, timestamptz columns and scoped nullable uniqueness in parity", () => {
    const ir = compileSpec(renderingSpec());
    const schema = renderPrismaSchema(ir);
    const migration = renderInitialMigration(ir, []);
    const idempotencyIndex = databaseNames.index(
      "Reservation",
      ["organizationId", "ownerId", "idempotencyKey"],
      true,
    );

    expect(schema).toContain("createdAt DateTime @default(now()) @db.Timestamptz(3)");
    expect(schema).toContain("startsAt DateTime @db.Timestamptz(3)");
    expect(migration).toContain('"startsAt" TIMESTAMPTZ(3) NOT NULL');
    expect(schema).toContain("idempotencyKey String?");
    expect(migration).toContain('"idempotencyKey" TEXT');
    expect(migration).not.toContain('"idempotencyKey" TEXT NOT NULL');

    expect(schema).toContain("onDelete: Restrict");
    expect(schema).toContain("onDelete: Cascade");
    expect(schema).toContain("onDelete: SetNull");
    expect(migration).toContain("ON DELETE RESTRICT ON UPDATE CASCADE");
    expect(migration).toContain("ON DELETE CASCADE ON UPDATE CASCADE");
    expect(migration).toContain("ON DELETE SET NULL ON UPDATE CASCADE");

    expect(schema).toContain(
      `@@unique([organizationId, ownerId, idempotencyKey], map: "${idempotencyIndex}")`,
    );
    expect(migration).toContain(`CREATE UNIQUE INDEX "${idempotencyIndex}"`);

    const mappedNames = [...schema.matchAll(/\bmap: "([^"]+)"/g)].map((match) => match[1]!);
    expect(new Set(mappedNames).size).toBe(mappedNames.length);
    for (const mappedName of mappedNames) {
      expect(migration).toContain(`"${mappedName}"`);
    }
  });

  it("fails closed when pre-v2 IR omits a referential action", () => {
    const ir = compileSpec(renderingSpec());
    const owner = ir.entities
      .find((entity) => entity.name === "Reservation")!
      .relations.find((relation) => relation.name === "owner")!;
    delete (owner as { onDelete?: typeof owner.onDelete }).onDelete;

    expect(() => renderPrismaSchema(ir)).toThrow(/missing IR referential action/);
    expect(() => renderInitialMigration(ir, [])).toThrow(/missing IR referential action/);
  });

  it("de-duplicates explicit indexes already represented by scalar and relation uniqueness", () => {
    const spec: BackendSpec = {
      specVersion: "backendcompiler.dev/v1",
      project: { name: "deduplicated-uniqueness" },
      target: { id: "nestjs-prisma", database: "postgresql" },
      entities: {
        Parent: {
          fields: { email: { type: "string", required: true, unique: true } },
          indexes: [{ fields: ["email"], unique: true }],
        },
        Child: {
          fields: { name: "string" },
          relations: [{ name: "parent", type: "hasOne", target: "Parent" }],
          indexes: [{ fields: ["parentId"], unique: true }],
        },
      },
      features: {},
    };
    const ir = compileSpec(spec);
    const schema = renderPrismaSchema(ir);
    const migration = renderInitialMigration(ir, []);

    for (const indexName of [
      databaseNames.index("Parent", ["email"], true),
      databaseNames.index("Child", ["parentId"], true),
    ]) {
      expect(schema.split(indexName)).toHaveLength(2);
      expect(migration.split(indexName)).toHaveLength(2);
    }
  });
});

describe("derived foreign-key indexes", () => {
  function scopedEntity(indexes: Array<{ fields: string[]; unique: boolean }>) {
    const entity = normalizeEntities([
      {
        name: "Organization",
        origin: "feature",
        fields: [{ name: "name", type: "string", required: true }],
      },
      {
        name: "User",
        origin: "spec",
        fields: [{ name: "email", type: "string", required: true }],
      },
      {
        name: "Resource",
        origin: "spec",
        fields: [{ name: "name", type: "string", required: true }],
      },
      {
        name: "ScopedRow",
        origin: "spec",
        fields: [{ name: "name", type: "string", required: true }],
        relations: [
          {
            name: "organization",
            type: "belongsTo",
            target: "Organization",
            required: true,
          },
          { name: "owner", type: "belongsTo", target: "User", required: true },
          { name: "resource", type: "belongsTo", target: "Resource", required: true },
        ],
        tenant: {
          relation: "organization",
          foreignKey: "organizationId",
          entity: "Organization",
        },
      },
    ]).find((candidate) => candidate.name === "ScopedRow")!;
    // The target helper accepts normalized indexes contributed by features as
    // well as user indexes. Assign directly so this focused test can exercise
    // coverage of implicit `createdAt`/`id` columns.
    entity.indexes = indexes;
    return entity;
  }

  it("includes the stable id tie-breaker and recognizes only genuinely covering prefixes", () => {
    const partiallyCovered = scopedEntity([
      { fields: ["organizationId"], unique: false },
      { fields: ["ownerId", "createdAt"], unique: false },
    ]);

    expect(derivedIndexes(partiallyCovered)).toEqual([
      { fields: ["organizationId", "createdAt", "id"] },
      { fields: ["resourceId"] },
    ]);

    const fullyCovered = scopedEntity([
      { fields: ["organizationId", "createdAt", "id", "name"], unique: false },
      { fields: ["ownerId"], unique: false },
      { fields: ["resourceId", "createdAt"], unique: false },
    ]);
    expect(derivedIndexes(fullyCovered)).toEqual([]);
  });
});

describe("PostgreSQL database object naming", () => {
  it("preserves short names and hash-suffixes long names deterministically", () => {
    expect(postgresIdentifier("Room_hotelId_fkey")).toBe("Room_hotelId_fkey");

    const prefix = `Reservation_${"veryLongRelation".repeat(5)}`;
    const first = postgresIdentifier(`${prefix}_idx`);
    const second = postgresIdentifier(`${prefix}_key`);

    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(
      POSTGRES_IDENTIFIER_MAX_BYTES,
    );
    expect(first).toBe(postgresIdentifier(`${prefix}_idx`));
    expect(first).not.toBe(second);
    expect(first).toMatch(/_[a-f0-9]{12}$/);
  });

  it("uses the same bounded long names in Prisma maps and SQL", () => {
    const longEntity = `Entity${"LongName".repeat(8)}`;
    const longField = `field${"LongName".repeat(8)}`;
    const longRelation = `parent${"LongRelation".repeat(6)}`;
    const spec: BackendSpec = {
      specVersion: "backendcompiler.dev/v1",
      project: { name: "long-database-names" },
      target: { id: "nestjs-prisma", database: "postgresql" },
      entities: {
        Parent: { fields: { name: "string" } },
        [longEntity]: {
          fields: { [longField]: { type: "string", required: true, unique: true } },
          relations: [
            {
              name: longRelation,
              type: "belongsTo",
              target: "Parent",
              required: true,
            },
          ],
        },
      },
      features: {},
    };
    const ir = compileSpec(spec);
    const schema = renderPrismaSchema(ir);
    const migration = renderInitialMigration(ir, []);
    const primaryKey = databaseNames.primaryKey(longEntity);
    const uniqueIndex = databaseNames.index(longEntity, [longField], true);
    const foreignKeyField = ir.entities
      .find((entity) => entity.name === longEntity)!
      .relations.find((relation) => relation.owner)!.foreignKey!;
    const foreignKey = databaseNames.foreignKey(longEntity, foreignKeyField);

    for (const name of [primaryKey, uniqueIndex, foreignKey]) {
      expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(
        POSTGRES_IDENTIFIER_MAX_BYTES,
      );
      expect(schema).toContain(`map: "${name}"`);
      expect(migration).toContain(`"${name}"`);
    }
  });
});
