import type { NormalizedEntity, NormalizedField } from "@backend-compiler/compiler";

function stringLength(field: NormalizedField): number {
  const minimum = field.constraints.minLength ?? 1;
  const maximum = field.constraints.maxLength ?? 32;
  return Math.min(Math.max(minimum, 8), Math.max(maximum, minimum), 32);
}

function numberValue(field: NormalizedField): number {
  const minimum = field.constraints.minimum ?? 1;
  const maximum = field.constraints.maximum ?? minimum + 1;
  return Math.min(minimum, maximum);
}

/**
 * A TypeScript expression producing a valid sample value for a field, used by
 * the generated test factories. Values respect the constraints the
 * specification declared, so generated fixtures never fail their own validation.
 */
export function sampleExpression(
  entity: NormalizedEntity,
  field: NormalizedField,
  form: "json" | "prisma",
): string {
  if (field.enumValues && field.enumValues.length > 0) {
    return `'${field.enumValues[0]}'`;
  }

  switch (field.type) {
    case "uuid":
      return "randomUUID()";
    case "integer":
      return String(numberValue(field));
    case "decimal":
      return String(numberValue(field));
    case "boolean":
      return "false";
    case "datetime":
    case "date":
      return form === "json" ? "new Date().toISOString()" : "new Date()";
    default:
      return `uniqueString(${stringLength(field)})`;
  }
}

export function sampleFields(entity: NormalizedEntity, fields: NormalizedField[], form: "json" | "prisma"): string[] {
  return fields.map((field) => `${field.name}: ${sampleExpression(entity, field, form)}`);
}
