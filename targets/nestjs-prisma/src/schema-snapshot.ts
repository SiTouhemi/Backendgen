import type { BackendIR } from "@backend-compiler/compiler";
import {
  SCHEMA_SNAPSHOT_VERSION,
  type SchemaSnapshot,
  type SnapshotColumn,
  type SnapshotEnum,
  type SnapshotForeignKey,
  type SnapshotIndex,
  type SnapshotTable,
} from "@backend-compiler/target-sdk";
import {
  columnDescriptors,
  enumDescriptors,
  foreignKeyDescriptors,
  indexDescriptors,
} from "./prisma-ddl.js";

function byName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function snapshotTable(entity: BackendIR["entities"][number]): SnapshotTable {
  const columns: SnapshotColumn[] = columnDescriptors(entity).map((column) => ({
    name: column.name,
    sqlType: column.sqlType,
    nullable: column.nullable,
    default: column.default,
  }));

  const indexes: SnapshotIndex[] = indexDescriptors(entity).map((index) => ({
    name: index.name,
    columns: [...index.columns],
    unique: index.unique,
  }));

  const foreignKeys: SnapshotForeignKey[] = foreignKeyDescriptors(entity).map((key) => ({
    name: key.name,
    column: key.column,
    target: key.target,
    onDelete: key.onDelete,
  }));

  return {
    name: entity.name,
    columns,
    indexes: byName(indexes),
    foreignKeys: byName(foreignKeys),
  };
}

/**
 * Derives the physical schema snapshot from the IR and the raw SQL features
 * contribute. It mirrors exactly what {@link renderInitialMigration} would
 * write, reusing the same column/index/foreign-key/enum descriptors, so a
 * regeneration whose IR is materially unchanged produces an empty diff.
 */
export function buildSchemaSnapshot(ir: BackendIR, featureSql: readonly string[]): SchemaSnapshot {
  const enums: SnapshotEnum[] = enumDescriptors(ir).map((descriptor) => ({
    name: descriptor.name,
    values: [...descriptor.values],
  }));

  const tables = ir.entities.map(snapshotTable);

  return {
    version: SCHEMA_SNAPSHOT_VERSION,
    enums: byName(enums),
    tables: byName(tables),
    featureSql: [...featureSql].map((statement) => statement.trim()).sort(),
  };
}

/** Deterministic, pretty-printed, newline-terminated so identical input yields an identical file. */
export function serializeSchemaSnapshot(snapshot: SchemaSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isColumn(value: unknown): value is SnapshotColumn {
  if (typeof value !== "object" || value === null) return false;
  const column = value as Record<string, unknown>;
  return (
    typeof column.name === "string" &&
    typeof column.sqlType === "string" &&
    typeof column.nullable === "boolean" &&
    (column.default === null || typeof column.default === "string")
  );
}

function isIndex(value: unknown): value is SnapshotIndex {
  if (typeof value !== "object" || value === null) return false;
  const index = value as Record<string, unknown>;
  return typeof index.name === "string" && isStringArray(index.columns) && typeof index.unique === "boolean";
}

function isForeignKey(value: unknown): value is SnapshotForeignKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.name === "string" &&
    typeof key.column === "string" &&
    typeof key.target === "string" &&
    typeof key.onDelete === "string"
  );
}

function isTable(value: unknown): value is SnapshotTable {
  if (typeof value !== "object" || value === null) return false;
  const table = value as Record<string, unknown>;
  return (
    typeof table.name === "string" &&
    Array.isArray(table.columns) &&
    table.columns.every(isColumn) &&
    Array.isArray(table.indexes) &&
    table.indexes.every(isIndex) &&
    Array.isArray(table.foreignKeys) &&
    table.foreignKeys.every(isForeignKey)
  );
}

function isEnum(value: unknown): value is SnapshotEnum {
  if (typeof value !== "object" || value === null) return false;
  const enumValue = value as Record<string, unknown>;
  return typeof enumValue.name === "string" && isStringArray(enumValue.values);
}

/**
 * Parses a serialized snapshot, returning null for anything this generator
 * cannot trust (wrong version, malformed shape). A null result makes the
 * generator fall back to the safe rewrite-in-place workflow rather than emit a
 * bogus incremental migration.
 */
export function parseSchemaSnapshot(raw: string): SchemaSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (candidate.version !== SCHEMA_SNAPSHOT_VERSION) return null;
  if (!Array.isArray(candidate.enums) || !candidate.enums.every(isEnum)) return null;
  if (!Array.isArray(candidate.tables) || !candidate.tables.every(isTable)) return null;
  if (!isStringArray(candidate.featureSql)) return null;

  return {
    version: SCHEMA_SNAPSHOT_VERSION,
    enums: candidate.enums,
    tables: candidate.tables,
    featureSql: candidate.featureSql,
  };
}
