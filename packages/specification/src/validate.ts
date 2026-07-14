import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";
import schema from "../schema/backend-spec.v1.schema.json" with { type: "json" };
import type {
  BackendSpec,
  EntityDefinition,
  FieldOptions,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = formatsModule as unknown as FormatsPlugin;
addFormats(ajv);
const validateSchema = ajv.compile<BackendSpec>(schema);

function schemaIssue(error: ErrorObject): ValidationIssue {
  const missingProperty =
    error.keyword === "required" && "missingProperty" in error.params
      ? `/${String(error.params.missingProperty)}`
      : "";

  return {
    code: `schema.${error.keyword}`,
    path: `${error.instancePath}${missingProperty}` || "/",
    message: error.message ?? "Invalid value",
  };
}

function fieldOptions(field: string | FieldOptions): FieldOptions {
  return typeof field === "string" ? { type: field as FieldOptions["type"] } : field;
}

function validateEntitySemantics(
  name: string,
  entity: EntityDefinition,
  entityNames: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [fieldName, field] of Object.entries(entity.fields)) {
    const options = fieldOptions(field);
    const path = `/entities/${name}/fields/${fieldName}`;

    if (
      options.minLength !== undefined &&
      options.maxLength !== undefined &&
      options.minLength > options.maxLength
    ) {
      issues.push({
        code: "semantic.invalid-length-range",
        path,
        message: "minLength cannot be greater than maxLength",
      });
    }

    if (
      options.minimum !== undefined &&
      options.maximum !== undefined &&
      options.minimum > options.maximum
    ) {
      issues.push({
        code: "semantic.invalid-number-range",
        path,
        message: "minimum cannot be greater than maximum",
      });
    }
  }

  for (const relation of entity.relations ?? []) {
    if (!entityNames.has(relation.target)) {
      issues.push({
        code: "semantic.unknown-relation-target",
        path: `/entities/${name}/relations/${relation.name}/target`,
        message: `Relation target '${relation.target}' does not exist`,
      });
    }
  }

  for (const [indexPosition, index] of (entity.indexes ?? []).entries()) {
    for (const fieldName of index.fields) {
      if (!(fieldName in entity.fields)) {
        issues.push({
          code: "semantic.unknown-index-field",
          path: `/entities/${name}/indexes/${indexPosition}/fields`,
          message: `Indexed field '${fieldName}' does not exist on entity '${name}'`,
        });
      }
    }
  }

  return issues;
}

function validateFeatureSemantics(spec: BackendSpec): ValidationIssue[] {
  const reservations = spec.features.reservations;
  if (!reservations) {
    return [];
  }

  const issues: ValidationIssue[] = [];
  for (const key of ["resource", "owner"] as const) {
    const value = reservations[key];
    if (typeof value !== "string" || !(value in spec.entities)) {
      issues.push({
        code: "semantic.unknown-feature-entity",
        path: `/features/reservations/${key}`,
        message: `Reservations ${key} must reference an existing entity`,
      });
    }
  }

  const holdMinutes = reservations.holdMinutes;
  if (holdMinutes !== undefined && (typeof holdMinutes !== "number" || holdMinutes <= 0)) {
    issues.push({
      code: "semantic.invalid-hold-duration",
      path: "/features/reservations/holdMinutes",
      message: "holdMinutes must be a positive number",
    });
  }

  return issues;
}

export function validateSpec(input: unknown): ValidationResult {
  if (!validateSchema(input)) {
    return {
      ok: false,
      issues: (validateSchema.errors ?? []).map(schemaIssue),
    };
  }

  const spec = input as BackendSpec;
  const entityNames = new Set(Object.keys(spec.entities));
  const issues = Object.entries(spec.entities).flatMap(([name, entity]) =>
    validateEntitySemantics(name, entity, entityNames),
  );
  issues.push(...validateFeatureSemantics(spec));

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: spec };
}
