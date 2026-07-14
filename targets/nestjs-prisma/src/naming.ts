import { createHash } from "node:crypto";
import { camelCase, kebabCase, pascalCase, pluralize } from "@backend-compiler/common";
import type { NormalizedEntity, NormalizedField } from "@backend-compiler/compiler";

export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

function utf8Prefix(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }

  return result;
}

/**
 * PostgreSQL truncates identifiers after 63 bytes, which can make two distinct
 * generated names collide. Preserve short names verbatim; long names receive a
 * stable SHA-256 suffix while remaining within PostgreSQL's byte limit.
 */
export function postgresIdentifier(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= POSTGRES_IDENTIFIER_MAX_BYTES) {
    return value;
  }

  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
  const prefixBytes = POSTGRES_IDENTIFIER_MAX_BYTES - Buffer.byteLength(digest, "utf8") - 1;
  return `${utf8Prefix(value, prefixBytes)}_${digest}`;
}

/** Database object names shared by Prisma attributes and the handwritten DDL. */
export const databaseNames = {
  primaryKey: (entity: string): string => postgresIdentifier(`${entity}_pkey`),
  index: (entity: string, fields: readonly string[], unique: boolean): string =>
    postgresIdentifier(`${entity}_${fields.join("_")}_${unique ? "key" : "idx"}`),
  foreignKey: (entity: string, field: string): string =>
    postgresIdentifier(`${entity}_${field}_fkey`),
};

/**
 * Naming rules shared by the target and by every feature renderer that targets
 * NestJS. Keeping them in one place is what stops two renderers disagreeing
 * about a file path or a class name.
 */
export const names = {
  /** Prisma model and NestJS class prefix, e.g. `Room`. */
  model: (entity: string): string => pascalCase(entity),
  /** Directory and file stem, e.g. `room`. */
  file: (entity: string): string => kebabCase(entity),
  /** Variable name, e.g. `room`. */
  variable: (entity: string): string => camelCase(entity),
  /** Prisma client delegate, e.g. `prisma.room`. */
  delegate: (entity: string): string => camelCase(entity),
  /** REST resource segment, e.g. `rooms`. */
  route: (entity: string): string => pluralize(kebabCase(entity)),
  /** Enum type name for a closed-set field, e.g. `ReservationStatus`. */
  enumType: (entity: string, field: string): string => `${pascalCase(entity)}${pascalCase(field)}`,
};

/** TypeScript type of a field as it appears on the Prisma model. */
export function modelType(entity: NormalizedEntity, field: NormalizedField): string {
  const base = (() => {
    if (field.enumValues) return names.enumType(entity.name, field.name);
    switch (field.type) {
      case "integer":
        return "number";
      case "decimal":
        return "Prisma.Decimal";
      case "boolean":
        return "boolean";
      case "datetime":
      case "date":
        return "Date";
      default:
        return "string";
    }
  })();
  return field.required ? base : `${base} | null`;
}

/** TypeScript type of a field as it appears on a request DTO. */
export function inputType(entity: NormalizedEntity, field: NormalizedField): string {
  if (field.enumValues) return names.enumType(entity.name, field.name);
  switch (field.type) {
    case "integer":
    case "decimal":
      return "number";
    case "boolean":
      return "boolean";
    case "datetime":
    case "date":
      return "string";
    default:
      return "string";
  }
}

/** TypeScript type of a field as it appears on a response DTO. */
export function outputType(entity: NormalizedEntity, field: NormalizedField): string {
  if (field.enumValues) return names.enumType(entity.name, field.name);
  switch (field.type) {
    case "integer":
      return "number";
    case "decimal":
      return "string";
    case "boolean":
      return "boolean";
    case "datetime":
    case "date":
      return "string";
    default:
      return "string";
  }
}

/** Fields a client may write: everything the compiler has not marked internal or read-only. */
export function writableFields(entity: NormalizedEntity): NormalizedField[] {
  return entity.fields.filter((field) => !field.internal && !field.readOnly);
}

/** Fields the API returns: everything except internal fields. */
export function readableFields(entity: NormalizedEntity): NormalizedField[] {
  return entity.fields.filter((field) => !field.internal);
}

/** Foreign keys a client may write, derived from the owning side of to-one relations. */
export function writableForeignKeys(
  entity: NormalizedEntity,
): Array<{ name: string; target: string; required: boolean }> {
  return entity.relations
    .filter((relation) => relation.owner && relation.foreignKey !== null)
    .filter((relation) => relation.foreignKey !== entity.tenant?.foreignKey)
    .filter((relation) => relation.foreignKey !== entity.ownership?.foreignKey)
    .map((relation) => ({
      name: relation.foreignKey as string,
      target: relation.target,
      required: relation.required,
    }));
}

/** Every foreign key stored on this entity, including scoping keys. */
export function foreignKeys(
  entity: NormalizedEntity,
): Array<{ name: string; target: string; required: boolean; unique: boolean }> {
  return entity.relations
    .filter((relation) => relation.owner && relation.foreignKey !== null)
    .map((relation) => ({
      name: relation.foreignKey as string,
      target: relation.target,
      required: relation.required,
      unique: relation.unique,
    }));
}

/**
 * Non-unique indexes derived from the entity's access paths, shared by the
 * Prisma schema and the initial migration so both always agree.
 *
 * Every owning foreign key gets an index (PostgreSQL does not index foreign
 * keys automatically) unless it is unique or an explicit index covers the
 * required leading columns. The tenant key gets a composite with `createdAt`
 * and the stable `id` tie-breaker used by generated list queries.
 */
export function derivedIndexes(entity: NormalizedEntity): Array<{ fields: string[] }> {
  const available = entity.indexes.map((index) => [...index.fields]);
  const derived: Array<{ fields: string[] }> = [];

  const isCovered = (required: readonly string[]): boolean =>
    available.some(
      (fields) =>
        fields.length >= required.length &&
        required.every((field, position) => fields[position] === field),
    );

  for (const relation of entity.relations) {
    const key = relation.foreignKey;
    if (!relation.owner || key === null || relation.unique) {
      continue;
    }

    const fields =
      key === entity.tenant?.foreignKey ? [key, "createdAt", "id"] : [key];
    if (isCovered(fields)) continue;

    available.push(fields);
    derived.push({ fields });
  }

  return derived;
}

export interface StandaloneIndex {
  fields: string[];
  unique: boolean;
}

function indexSignature(fields: readonly string[], unique: boolean): string {
  return JSON.stringify([unique, fields]);
}

/**
 * Model-level indexes left after field/relation `@unique` attributes are
 * accounted for. Keeping this list in one helper makes Prisma and the initial
 * SQL migration de-duplicate the same declarations in the same order.
 */
export function standaloneIndexes(entity: NormalizedEntity): StandaloneIndex[] {
  const seen = new Set<string>();
  const result: StandaloneIndex[] = [];

  for (const field of entity.fields) {
    if (field.unique) seen.add(indexSignature([field.name], true));
  }
  for (const key of foreignKeys(entity)) {
    if (key.unique) seen.add(indexSignature([key.name], true));
  }

  const add = (fields: readonly string[], unique: boolean): void => {
    const signature = indexSignature(fields, unique);
    if (seen.has(signature)) return;
    seen.add(signature);
    result.push({ fields: [...fields], unique });
  };

  for (const index of entity.indexes) add(index.fields, index.unique);
  for (const index of derivedIndexes(entity)) add(index.fields, false);
  if (entity.softDelete) add(["deletedAt"], false);

  return result;
}

export function enumFields(
  entity: NormalizedEntity,
): Array<{ field: NormalizedField; typeName: string; values: string[] }> {
  return entity.fields
    .filter((field) => field.enumValues !== null)
    .map((field) => ({
      field,
      typeName: names.enumType(entity.name, field.name),
      values: field.enumValues as string[],
    }));
}
