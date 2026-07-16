import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";
import { camelCase, pascalCase, pluralize } from "@backend-compiler/common";
import schema from "../schema/backend-spec.v1.schema.json" with { type: "json" };
import type {
  BackendSpec,
  EntityDefinition,
  FieldOptions,
  RelationDefinition,
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

function defaultInverseName(sourceEntity: string, type: RelationDefinition["type"]): string {
  const singular = camelCase(sourceEntity);
  return type === "belongsTo" || type === "manyToMany" ? pluralize(singular) : singular;
}

/**
 * Derives the scalar foreign-key fields created by relation normalization.
 * This intentionally mirrors the compiler's relation-name collision rules so
 * schema validation and compilation accept exactly the same index fields.
 */
function deriveRelationForeignKeys(
  entities: BackendSpec["entities"],
): ReadonlyMap<string, ReadonlySet<string>> {
  const foreignKeys = new Map<string, Set<string>>(
    Object.keys(entities).map((name) => [name, new Set<string>()]),
  );
  const takenNames = new Map<string, Set<string>>(
    Object.entries(entities).map(([name, entity]) => [
      name,
      new Set([
        ...Object.keys(entity.fields),
        ...(entity.relations ?? []).map((relation) => relation.name),
      ]),
    ]),
  );

  const sortedEntities = Object.entries(entities).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  for (const [sourceName, entity] of sortedEntities) {
    const relations = [...(entity.relations ?? [])].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    for (const relation of relations) {
      const targetTaken = takenNames.get(relation.target);
      if (targetTaken === undefined) continue;

      let inverseName = defaultInverseName(sourceName, relation.type);
      if (targetTaken.has(inverseName)) {
        inverseName = `${inverseName}Via${pascalCase(relation.name)}`;
      }
      targetTaken.add(inverseName);

      if (relation.type === "belongsTo" || relation.type === "hasOne") {
        foreignKeys.get(sourceName)!.add(`${camelCase(relation.name)}Id`);
      } else if (relation.type === "hasMany") {
        foreignKeys.get(relation.target)!.add(`${camelCase(inverseName)}Id`);
      }
    }
  }

  return foreignKeys;
}

function fieldOptions(field: string | FieldOptions): FieldOptions {
  return typeof field === "string" ? { type: field as FieldOptions["type"] } : field;
}

function validateEntitySemantics(
  name: string,
  entity: EntityDefinition,
  entityNames: Set<string>,
  relationForeignKeys: ReadonlySet<string>,
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

    const isCollection = relation.type === "hasMany" || relation.type === "manyToMany";
    if (isCollection && relation.required !== undefined) {
      issues.push({
        code: "semantic.collection-relation-required-unsupported",
        path: `/entities/${name}/relations/${relation.name}/required`,
        message: `${relation.type} is a collection relation; required only applies to belongsTo and hasOne relations that own a foreign key`,
      });
    } else if (relation.onDelete === "setNull" && relation.required === true) {
      issues.push({
        code: "semantic.set-null-requires-optional-relation",
        path: `/entities/${name}/relations/${relation.name}/onDelete`,
        message:
          "onDelete: setNull needs an optional relation; a required foreign key cannot be set to null. Use restrict or cascade, or make the relation optional.",
      });
    }

    if (relation.type === "manyToMany" && relation.onDelete !== undefined) {
      issues.push({
        code: "semantic.many-to-many-on-delete-unsupported",
        path: `/entities/${name}/relations/${relation.name}/onDelete`,
        message:
          "manyToMany has no owning foreign key in this IR; model the join table explicitly to control its referential actions",
      });
    }
  }

  // Implicit columns every entity carries; softDelete's deletedAt is feature
  // configuration the specification layer cannot see, so it is not accepted here.
  const implicitColumns = new Set(["id", "createdAt", "updatedAt"]);

  for (const [indexPosition, index] of (entity.indexes ?? []).entries()) {
    for (const fieldName of index.fields) {
      if (
        !(fieldName in entity.fields) &&
        !relationForeignKeys.has(fieldName) &&
        !implicitColumns.has(fieldName)
      ) {
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

function validateAuthDeliverySemantics(spec: BackendSpec): ValidationIssue[] {
  const auth = spec.features.auth;
  if (!auth || spec.features.notifications !== undefined) {
    return [];
  }

  // Both flows default to true in the auth feature schema, so "not explicitly
  // disabled" means enabled.
  const issues: ValidationIssue[] = [];
  const flows: Array<[flag: string, what: string]> = [
    ["emailVerification", "email verification tokens"],
    ["passwordReset", "password reset tokens"],
  ];

  for (const [flag, what] of flows) {
    if (auth[flag] !== false) {
      issues.push({
        code: "semantic.auth-recovery-undeliverable",
        path: `/features/auth/${flag}`,
        message:
          `auth.${flag} issues ${what}, but no delivery path exists without the ` +
          "notifications feature. Enable notifications with a delivering resend/custom " +
          `provider, or set ${flag}: false explicitly.`,
      });
    }
  }

  return issues;
}

function validateFeatureSemantics(spec: BackendSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [...validateAuthDeliverySemantics(spec)];

  const reservations = spec.features.reservations;
  if (!reservations) {
    return issues;
  }
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

  // 0 is meaningful: it disables holds and confirms immediately. The feature's
  // own schema enforces the full range; only clearly nonsensical values are
  // rejected this early.
  const holdMinutes = reservations.holdMinutes;
  if (holdMinutes !== undefined && (typeof holdMinutes !== "number" || holdMinutes < 0)) {
    issues.push({
      code: "semantic.invalid-hold-duration",
      path: "/features/reservations/holdMinutes",
      message: "holdMinutes must be zero or a positive number",
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
  const relationForeignKeys = deriveRelationForeignKeys(spec.entities);
  const issues = Object.entries(spec.entities).flatMap(([name, entity]) =>
    validateEntitySemantics(name, entity, entityNames, relationForeignKeys.get(name) ?? new Set()),
  );
  issues.push(...validateFeatureSemantics(spec));

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: spec };
}
