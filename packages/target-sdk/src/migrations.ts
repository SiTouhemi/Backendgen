import type { BackendIR } from "@backend-compiler/compiler";

/**
 * A framework-independent snapshot of the physical database schema a target
 * would produce for a given IR. It is deliberately expressed in the target's
 * own SQL vocabulary (`sqlType` strings, database object names) rather than the
 * IR, because that is exactly what an incremental migration must diff: two
 * generations whose IR differs only cosmetically must produce no DDL.
 *
 * The differ (in the generator runtime) compares two snapshots; the target maps
 * the resulting change list back to SQL. Both sides share these types so a
 * change kind can never mean two different things.
 */
export const SCHEMA_SNAPSHOT_VERSION = 1 as const;

export interface SnapshotColumn {
  name: string;
  /** Rendered SQL type, e.g. `TEXT`, `TIMESTAMPTZ(3)`, or a quoted enum name. */
  sqlType: string;
  nullable: boolean;
  /** SQL default literal without the `DEFAULT` keyword, e.g. `'ACTIVE'`, `false`, `CURRENT_TIMESTAMP`. */
  default: string | null;
}

export interface SnapshotIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface SnapshotForeignKey {
  name: string;
  column: string;
  /** Referenced table name; the referenced column is always `id`. */
  target: string;
  /** Rendered referential action, e.g. `RESTRICT`, `CASCADE`, `SET NULL`. */
  onDelete: string;
}

export interface SnapshotTable {
  name: string;
  columns: SnapshotColumn[];
  indexes: SnapshotIndex[];
  foreignKeys: SnapshotForeignKey[];
}

export interface SnapshotEnum {
  name: string;
  values: string[];
}

export interface SchemaSnapshot {
  version: typeof SCHEMA_SNAPSHOT_VERSION;
  enums: SnapshotEnum[];
  tables: SnapshotTable[];
  /** Raw SQL statements features contribute that Prisma's schema cannot express. */
  featureSql: string[];
}

/**
 * An ordered, target-independent description of one schema change. The differ
 * emits these; the target's SQL emitter consumes them. Ordering guarantees
 * (drops before adds, parents before children) are the differ's responsibility.
 */
export type SchemaChange =
  | { kind: "create-table"; table: string; snapshot: SnapshotTable }
  | { kind: "drop-table"; table: string }
  | { kind: "add-column"; table: string; column: SnapshotColumn }
  | { kind: "drop-column"; table: string; column: string }
  | { kind: "alter-column-type"; table: string; column: string; from: string; to: string }
  | { kind: "alter-column-nullability"; table: string; column: string; nullable: boolean }
  | { kind: "alter-column-default"; table: string; column: string; default: string | null }
  | { kind: "add-index"; table: string; index: SnapshotIndex }
  | { kind: "drop-index"; table: string; index: string }
  | { kind: "add-foreign-key"; table: string; foreignKey: SnapshotForeignKey; recreated: boolean }
  | { kind: "drop-foreign-key"; table: string; foreignKey: string }
  | { kind: "create-enum"; enum: SnapshotEnum }
  | { kind: "add-enum-value"; enum: string; value: string; after: string | null }
  | { kind: "drop-enum"; enum: string }
  | { kind: "add-feature-sql"; sql: string }
  | { kind: "drop-feature-sql"; sql: string };

export type SchemaChangeKind = SchemaChange["kind"];

/**
 * The migration capability a target may expose. When present, the generator
 * runtime records a schema snapshot after every generation and, on the next
 * generation, emits an incremental migration for whatever changed instead of
 * rewriting the initial migration in place.
 */
export interface TargetMigrationSupport {
  /** Directory of the immutable initial migration, e.g. `prisma/migrations/00000000000000_init`. */
  initialMigrationDirectory: string;
  /** Directory that holds every migration folder, e.g. `prisma/migrations`. */
  migrationsRoot: string;
  /** Prefix used for incremental migration folder names, e.g. `backendgen`. */
  incrementalTag: string;
  buildSnapshot(ir: BackendIR, featureSql: readonly string[]): SchemaSnapshot;
  serializeSnapshot(snapshot: SchemaSnapshot): string;
  /** Returns null when the input is not a snapshot this generator can trust. */
  parseSnapshot(raw: string): SchemaSnapshot | null;
  renderDiffMigration(
    changes: readonly SchemaChange[],
    options: { allowDestructive: boolean },
  ): string;
}
