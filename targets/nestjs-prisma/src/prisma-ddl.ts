import type {
  BackendIR,
  NormalizedEntity,
  NormalizedField,
  NormalizedRelation,
} from "@backend-compiler/compiler";
import { databaseNames, enumFields, foreignKeys, names, standaloneIndexes } from "./naming.js";

export const SCALAR_TO_SQL: Readonly<Record<string, string>> = {
  string: "TEXT",
  text: "TEXT",
  integer: "INTEGER",
  decimal: "DECIMAL(65,30)",
  boolean: "BOOLEAN",
  datetime: "TIMESTAMPTZ(3)",
  date: "DATE",
  uuid: "TEXT",
};

export const ON_DELETE_TO_SQL: Readonly<Record<NormalizedRelation["onDelete"], string>> = {
  restrict: "RESTRICT",
  cascade: "CASCADE",
  setNull: "SET NULL",
};

export function sqlOnDelete(action: NormalizedRelation["onDelete"]): string {
  const rendered = ON_DELETE_TO_SQL[action];
  if (rendered === undefined) {
    throw new Error(`Unsupported or missing IR referential action: ${String(action)}`);
  }
  return rendered;
}

export function sqlType(entity: NormalizedEntity, field: NormalizedField): string {
  if (field.enumValues) {
    return `"${names.enumType(entity.name, field.name)}"`;
  }
  return SCALAR_TO_SQL[field.type] ?? "TEXT";
}

/**
 * The SQL default literal (without the `DEFAULT` keyword), or null when the
 * field has none. Shared by the initial migration, the schema snapshot and the
 * incremental migration emitter so all three agree on how a literal is spelled.
 */
export function sqlDefaultLiteral(field: NormalizedField): string | null {
  const value = field.defaultValue;
  if (value === null) return null;
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return String(value);
}

function sqlDefault(field: NormalizedField): string {
  const literal = sqlDefaultLiteral(field);
  return literal === null ? "" : ` DEFAULT ${literal}`;
}

export interface ColumnDescriptor {
  name: string;
  sqlType: string;
  nullable: boolean;
  default: string | null;
}

/**
 * Every column the target creates for an entity, in table order (implicit
 * `id`/timestamps first, then declared fields, then foreign keys). Shared by the
 * initial migration and the schema snapshot so neither can drift from the other.
 */
export function columnDescriptors(entity: NormalizedEntity): ColumnDescriptor[] {
  const columns: ColumnDescriptor[] = [
    { name: "id", sqlType: "TEXT", nullable: false, default: null },
    { name: "createdAt", sqlType: "TIMESTAMPTZ(3)", nullable: false, default: "CURRENT_TIMESTAMP" },
    { name: "updatedAt", sqlType: "TIMESTAMPTZ(3)", nullable: false, default: null },
  ];

  if (entity.softDelete) {
    columns.push({ name: "deletedAt", sqlType: "TIMESTAMPTZ(3)", nullable: true, default: null });
  }

  for (const field of entity.fields) {
    columns.push({
      name: field.name,
      sqlType: sqlType(entity, field),
      nullable: !field.required,
      default: sqlDefaultLiteral(field),
    });
  }

  for (const key of foreignKeys(entity)) {
    columns.push({ name: key.name, sqlType: "TEXT", nullable: !key.required, default: null });
  }

  return columns;
}

function columnLine(column: ColumnDescriptor): string {
  const nullability = column.nullable ? "" : " NOT NULL";
  const fallback = column.default === null ? "" : ` DEFAULT ${column.default}`;
  return `    "${column.name}" ${column.sqlType}${nullability}${fallback}`;
}

/**
 * `CREATE TABLE` body from column descriptors and the derived primary key. Used
 * by both the initial migration and the incremental migration emitter so a
 * newly created table looks the same however it came to be created.
 */
export function renderCreateTable(tableName: string, columns: readonly ColumnDescriptor[]): string {
  const lines = columns.map(columnLine);
  lines.push(`    CONSTRAINT "${databaseNames.primaryKey(tableName)}" PRIMARY KEY ("id")`);
  return [`CREATE TABLE "${tableName}" (`, lines.join(",\n"), ");"].join("\n");
}

function createTable(entity: NormalizedEntity): string {
  return ["-- CreateTable", renderCreateTable(entity.name, columnDescriptors(entity))].join("\n");
}

export interface IndexDescriptor {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeyDescriptor {
  name: string;
  column: string;
  target: string;
  onDelete: string;
}

export interface EnumDescriptor {
  name: string;
  values: string[];
}

/**
 * Every index the target creates for an entity, in emission order. Centralised
 * so the initial migration, the Prisma schema and the schema snapshot cannot
 * disagree about which indexes exist or what they are named.
 */
export function indexDescriptors(entity: NormalizedEntity): IndexDescriptor[] {
  const descriptors: IndexDescriptor[] = [];

  for (const field of entity.fields) {
    if (field.unique) {
      descriptors.push({
        name: databaseNames.index(entity.name, [field.name], true),
        columns: [field.name],
        unique: true,
      });
    }
  }

  for (const key of foreignKeys(entity)) {
    if (key.unique) {
      descriptors.push({
        name: databaseNames.index(entity.name, [key.name], true),
        columns: [key.name],
        unique: true,
      });
    }
  }

  for (const index of standaloneIndexes(entity)) {
    descriptors.push({
      name: databaseNames.index(entity.name, index.fields, index.unique),
      columns: [...index.fields],
      unique: index.unique,
    });
  }

  return descriptors;
}

export function foreignKeyDescriptors(entity: NormalizedEntity): ForeignKeyDescriptor[] {
  return entity.relations
    .filter((relation) => relation.owner && relation.foreignKey !== null)
    .map((relation) => ({
      name: databaseNames.foreignKey(entity.name, relation.foreignKey!),
      column: relation.foreignKey!,
      target: relation.target,
      onDelete: sqlOnDelete(relation.onDelete),
    }));
}

export function enumDescriptors(ir: BackendIR): EnumDescriptor[] {
  return ir.entities.flatMap((entity) =>
    enumFields(entity).map(({ typeName, values }) => ({ name: typeName, values: [...values] })),
  );
}

function createIndexes(entity: NormalizedEntity): string[] {
  return indexDescriptors(entity).map((index) => {
    const columns = index.columns.map((field) => `"${field}"`).join(", ");
    return `CREATE${index.unique ? " UNIQUE" : ""} INDEX "${index.name}" ON "${entity.name}"(${columns});`;
  });
}

function foreignKeyStatements(entity: NormalizedEntity): string[] {
  return foreignKeyDescriptors(entity).map(
    (key) =>
      `ALTER TABLE "${entity.name}" ADD CONSTRAINT "${key.name}" ` +
      `FOREIGN KEY ("${key.column}") REFERENCES "${key.target}"("id") ` +
      `ON DELETE ${key.onDelete} ON UPDATE CASCADE;`,
  );
}

function createEnums(ir: BackendIR): string[] {
  return enumDescriptors(ir).map((descriptor) => {
    const literals = descriptor.values.map((value) => `'${value}'`).join(", ");
    return `CREATE TYPE "${descriptor.name}" AS ENUM (${literals});`;
  });
}

/**
 * Emits the initial migration as SQL rather than shelling out to
 * `prisma migrate dev`, which needs a live shadow database. The result is
 * deterministic and applies offline with `prisma migrate deploy`.
 *
 * `extraSql` carries statements features cannot express through the Prisma
 * schema — most importantly the reservation overlap `EXCLUDE` constraint.
 */
export function renderInitialMigration(ir: BackendIR, extraSql: readonly string[]): string {
  const sections: string[] = [
    "-- Generated by backendgen. Applied with `prisma migrate deploy`.",
  ];

  const enums = createEnums(ir);
  if (enums.length > 0) {
    sections.push(["-- CreateEnum", ...enums].join("\n"));
  }

  for (const entity of ir.entities) {
    sections.push(createTable(entity));
  }

  const indexes = ir.entities.flatMap(createIndexes);
  if (indexes.length > 0) {
    sections.push(["-- CreateIndex", ...indexes].join("\n"));
  }

  const constraints = ir.entities.flatMap(foreignKeyStatements);
  if (constraints.length > 0) {
    sections.push(["-- AddForeignKey", ...constraints].join("\n"));
  }

  for (const statement of extraSql) {
    sections.push(statement.trim());
  }

  return `${sections.join("\n\n")}\n`;
}

export const MIGRATIONS_ROOT = "prisma/migrations";
export const MIGRATION_DIRECTORY = `${MIGRATIONS_ROOT}/00000000000000_init`;
