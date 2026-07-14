import { camelCase, kebabCase, pascalCase, pluralize } from "@backend-compiler/common";
import type { NormalizedEntity, NormalizedField } from "@backend-compiler/compiler";

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
