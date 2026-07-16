import { camelCase, CompilerError, issue, pascalCase, pluralize } from "@backend-compiler/common";
import type {
  BackendSpec,
  EntityDefinition,
  FieldDefinition,
  FieldOptions,
} from "@backend-compiler/specification";
import type { DraftEntity, DraftField, DraftRelation, EntityPatch } from "./drafts.js";
import {
  IR_VERSION,
  type BackendIR,
  type Database,
  type NormalizedEntity,
  type NormalizedField,
  type NormalizedRelation,
} from "./ir.js";

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function fieldOptions(definition: FieldDefinition): FieldOptions {
  return typeof definition === "string" ? { type: definition } : definition;
}

function specFieldToDraft(name: string, definition: FieldDefinition): DraftField {
  const options = fieldOptions(definition);
  const draft: DraftField = { name, type: options.type };

  if (options.required !== undefined) draft.required = options.required;
  if (options.unique !== undefined) draft.unique = options.unique;
  if (options.description !== undefined) draft.description = options.description;
  if (options.minimum !== undefined) draft.minimum = options.minimum;
  if (options.maximum !== undefined) draft.maximum = options.maximum;
  if (options.minLength !== undefined) draft.minLength = options.minLength;
  if (options.maxLength !== undefined) draft.maxLength = options.maxLength;
  if (options.enum !== undefined) draft.enumValues = [...options.enum];
  if (options.default !== undefined) draft.defaultValue = options.default;

  return draft;
}

function specEntityToDraft(name: string, definition: EntityDefinition): DraftEntity {
  const draft: DraftEntity = {
    name,
    origin: "spec",
    fields: Object.entries(definition.fields).map(([fieldName, field]) =>
      specFieldToDraft(fieldName, field),
    ),
    relations: (definition.relations ?? []).map((relation) => {
      const result: DraftRelation = {
        name: relation.name,
        type: relation.type,
        target: relation.target,
      };
      if (relation.required !== undefined) result.required = relation.required;
      if (relation.onDelete !== undefined) result.onDelete = relation.onDelete;
      return result;
    }),
    indexes: (definition.indexes ?? []).map((index) => ({
      fields: [...index.fields],
      unique: index.unique ?? false,
    })),
  };

  if (definition.description !== undefined) draft.description = definition.description;
  return draft;
}

/** Lowers the user specification into drafts, before any feature runs. */
export function specToDrafts(spec: BackendSpec): DraftEntity[] {
  return Object.entries(spec.entities)
    .map(([name, definition]) => specEntityToDraft(name, definition))
    .sort(byName);
}

/**
 * Applies feature entity contributions in resolution order. Later features can
 * override flags set by earlier ones, which is how `auth` removes its user table
 * from the generic CRUD surface.
 */
export function applyEntityContributions(
  base: DraftEntity[],
  created: DraftEntity[],
  patches: EntityPatch[],
): DraftEntity[] {
  const entities = new Map<string, DraftEntity>();
  for (const entity of base) {
    entities.set(entity.name, structuredClone(entity));
  }

  for (const entity of created) {
    if (entities.has(entity.name)) {
      throw new CompilerError(`Entity '${entity.name}' already exists`, [
        issue(
          "feature.entity-conflict",
          `/entities/${entity.name}`,
          `Feature '${entity.ownerFeature ?? "unknown"}' creates entity '${entity.name}', but it is already defined`,
        ),
      ]);
    }
    entities.set(entity.name, structuredClone(entity));
  }

  for (const patch of patches) {
    const entity = entities.get(patch.entity);
    if (!entity) {
      throw new CompilerError(`Entity '${patch.entity}' does not exist`, [
        issue(
          "feature.missing-entity",
          `/entities/${patch.entity}`,
          `A feature tried to extend unknown entity '${patch.entity}'`,
        ),
      ]);
    }

    for (const field of patch.addFields ?? []) {
      if (entity.fields.some((existing) => existing.name === field.name)) {
        throw new CompilerError(`Field '${patch.entity}.${field.name}' is reserved by a feature`, [
          issue(
            "feature.field-conflict",
            `/entities/${patch.entity}/fields/${field.name}`,
            `A feature must add '${patch.entity}.${field.name}', but that field is already declared. Remove the conflicting field so the feature can enforce its required type and security flags.`,
          ),
        ]);
      }
      entity.fields.push(structuredClone(field));
    }

    for (const relation of patch.addRelations ?? []) {
      entity.relations ??= [];
      if (entity.relations.some((existing) => existing.name === relation.name)) {
        throw new CompilerError(
          `Relation '${patch.entity}.${relation.name}' is reserved by a feature`,
          [
            issue(
              "feature.relation-conflict",
              `/entities/${patch.entity}/relations/${relation.name}`,
              `A feature must add '${patch.entity}.${relation.name}', but that relation is already declared. Remove the conflicting relation so the feature can enforce its ownership and referential rules.`,
            ),
          ],
        );
      }
      entity.relations.push(structuredClone(relation));
    }

    if (patch.addIndexes && patch.addIndexes.length > 0) {
      entity.indexes = [...(entity.indexes ?? []), ...structuredClone(patch.addIndexes)];
    }

    if (patch.crud !== undefined) entity.crud = patch.crud;
    if (patch.softDelete !== undefined) entity.softDelete = patch.softDelete;
    if (patch.ownership !== undefined) {
      if (patch.ownership === null) delete entity.ownership;
      else entity.ownership = structuredClone(patch.ownership);
    }
    if (patch.tenant !== undefined) {
      if (patch.tenant === null) delete entity.tenant;
      else entity.tenant = structuredClone(patch.tenant);
    }
  }

  return [...entities.values()].sort(byName);
}

function normalizeField(field: DraftField): NormalizedField {
  return {
    name: field.name,
    type: field.type,
    required: field.required ?? false,
    unique: field.unique ?? false,
    description: field.description ?? null,
    enumValues: field.enumValues ? [...field.enumValues] : null,
    defaultValue: field.defaultValue ?? null,
    internal: field.internal ?? false,
    readOnly: field.readOnly ?? false,
    constraints: {
      minimum: field.minimum ?? null,
      maximum: field.maximum ?? null,
      minLength: field.minLength ?? null,
      maxLength: field.maxLength ?? null,
    },
  };
}

interface RelationSide {
  entity: string;
  relation: NormalizedRelation;
}

function defaultInverseName(sourceEntity: string, type: DraftRelation["type"]): string {
  const singular = camelCase(sourceEntity);
  switch (type) {
    case "belongsTo":
    case "manyToMany":
      return pluralize(singular);
    case "hasOne":
    case "hasMany":
      return singular;
  }
}

/**
 * Expands each declared relation into the pair of sides the datastore needs.
 * Only one side is declared in the specification; the inverse is derived so that
 * targets (and Prisma in particular, which requires both sides) never have to
 * guess.
 */
function deriveRelationSides(entities: DraftEntity[]): Map<string, NormalizedRelation[]> {
  const known = new Set(entities.map((entity) => entity.name));
  const sides = new Map<string, RelationSide[]>();
  for (const entity of entities) {
    sides.set(entity.name, []);
  }

  const takenNames = new Map<string, Set<string>>();
  for (const entity of entities) {
    takenNames.set(
      entity.name,
      new Set([
        ...entity.fields.map((field) => field.name),
        ...(entity.relations ?? []).map((relation) => relation.name),
      ]),
    );
  }

  const sorted = [...entities].sort(byName);
  for (const entity of sorted) {
    const relations = [...(entity.relations ?? [])].sort(byName);
    for (const relation of relations) {
      if (!known.has(relation.target)) {
        throw new CompilerError(`Unknown relation target '${relation.target}'`, [
          issue(
            "semantic.unknown-relation-target",
            `/entities/${entity.name}/relations/${relation.name}/target`,
            `Relation target '${relation.target}' does not exist`,
          ),
        ]);
      }

      if (
        (relation.type === "hasMany" || relation.type === "manyToMany") &&
        relation.required !== undefined
      ) {
        throw new CompilerError("Collection relations cannot be required", [
          issue(
            "semantic.collection-relation-required-unsupported",
            `/entities/${entity.name}/relations/${relation.name}/required`,
            `Relation '${relation.name}' is ${relation.type}; required only applies to belongsTo and hasOne relations that own a foreign key`,
          ),
        ]);
      }

      if (relation.type === "manyToMany" && relation.onDelete !== undefined) {
        throw new CompilerError("manyToMany does not support onDelete", [
          issue(
            "semantic.many-to-many-on-delete-unsupported",
            `/entities/${entity.name}/relations/${relation.name}/onDelete`,
            "manyToMany has no owning foreign key in this IR; model the join table explicitly to control its referential actions",
          ),
        ]);
      }

      const relationName = `${entity.name}${pascalCase(relation.name)}`;
      const targetTaken = takenNames.get(relation.target)!;

      let inverseName = relation.inverseName ?? defaultInverseName(entity.name, relation.type);
      if (targetTaken.has(inverseName)) {
        inverseName = `${inverseName}Via${pascalCase(relation.name)}`;
      }
      targetTaken.add(inverseName);

      const declaredOwnsForeignKey =
        relation.type === "belongsTo" || relation.type === "hasOne";
      const foreignKey = relation.foreignKey ?? `${camelCase(relation.name)}Id`;
      const inverseForeignKey = relation.foreignKey ?? `${camelCase(inverseName)}Id`;

      // Deleting a parent must not silently destroy dependants: restrict is the
      // default for a required owning relation and cascade is explicit only.
      // A declared hasMany places an optional foreign key on its derived
      // inverse side, so setNull is its safe default.
      const required = relation.required ?? false;
      const onDelete =
        relation.onDelete ??
        (declaredOwnsForeignKey && required ? "restrict" : "setNull");

      if (onDelete === "setNull" && declaredOwnsForeignKey && required) {
        throw new CompilerError("setNull requires an optional relation", [
          issue(
            "semantic.set-null-requires-optional-relation",
            `/entities/${entity.name}/relations/${relation.name}/onDelete`,
            "onDelete: setNull cannot apply to a required relation; the foreign key cannot become null",
          ),
        ]);
      }

      const declared: NormalizedRelation = {
        name: relation.name,
        type: relation.type,
        target: relation.target,
        required,
        origin: "declared",
        inverseName,
        relationName,
        owner: declaredOwnsForeignKey,
        foreignKey: declaredOwnsForeignKey ? foreignKey : null,
        unique: relation.type === "hasOne",
        onDelete,
      };

      const inverseType: NormalizedRelation["type"] =
        relation.type === "belongsTo"
          ? "hasMany"
          : relation.type === "hasMany"
            ? "belongsTo"
            : relation.type === "hasOne"
              ? "hasOne"
              : "manyToMany";

      const inverse: NormalizedRelation = {
        name: inverseName,
        type: inverseType,
        target: entity.name,
        required: false,
        origin: "derived",
        inverseName: relation.name,
        relationName,
        owner: relation.type === "hasMany",
        foreignKey: relation.type === "hasMany" ? inverseForeignKey : null,
        unique: relation.type === "hasOne",
        // For a declared hasMany the derived inverse owns the (optional)
        // foreign key, so the declared side's onDelete applies here.
        onDelete,
      };

      sides.get(entity.name)!.push({ entity: entity.name, relation: declared });
      sides.get(relation.target)!.push({ entity: relation.target, relation: inverse });
    }
  }

  const result = new Map<string, NormalizedRelation[]>();
  for (const [entityName, entitySides] of sides) {
    result.set(
      entityName,
      entitySides.map((side) => side.relation).sort(byName),
    );
  }
  return result;
}

function validateImplicitNames(
  drafts: readonly DraftEntity[],
  relations: ReadonlyMap<string, readonly NormalizedRelation[]>,
): void {
  for (const draft of drafts) {
    const reserved = new Set(["id", "createdAt", "updatedAt"]);
    if (draft.softDelete) reserved.add("deletedAt");

    for (const field of draft.fields) {
      if (reserved.has(field.name)) {
        throw new CompilerError(`Field '${draft.name}.${field.name}' is reserved`, [
          issue(
            "semantic.reserved-field-name",
            `/entities/${draft.name}/fields/${field.name}`,
            `Field '${field.name}' is generated by the target for every ${draft.softDelete ? "matching " : ""}entity and cannot be declared explicitly.`,
          ),
        ]);
      }
    }

    const scalarNames = new Set(draft.fields.map((field) => field.name));
    const relationNames = new Set<string>();
    const foreignKeyNames = new Set<string>();

    for (const relation of relations.get(draft.name) ?? []) {
      if (reserved.has(relation.name) || scalarNames.has(relation.name)) {
        throw new CompilerError(`Relation '${draft.name}.${relation.name}' collides with a field`, [
          issue(
            "semantic.relation-field-name-conflict",
            `/entities/${draft.name}/relations/${relation.name}`,
            `Relation '${relation.name}' conflicts with a scalar or generated field on '${draft.name}'.`,
          ),
        ]);
      }
      relationNames.add(relation.name);
    }

    for (const relation of relations.get(draft.name) ?? []) {
      const foreignKey = relation.foreignKey;
      if (!relation.owner || foreignKey === null) continue;

      if (
        reserved.has(foreignKey) ||
        scalarNames.has(foreignKey) ||
        relationNames.has(foreignKey) ||
        foreignKeyNames.has(foreignKey)
      ) {
        throw new CompilerError(
          `Foreign key '${draft.name}.${foreignKey}' collides with another field`,
          [
            issue(
              "semantic.foreign-key-name-conflict",
              `/entities/${draft.name}/relations/${relation.name}/foreignKey`,
              `Relation '${relation.name}' generates foreign key '${foreignKey}', which conflicts with another scalar, relation, or generated field on '${draft.name}'.`,
            ),
          ],
        );
      }
      foreignKeyNames.add(foreignKey);
    }
  }
}

export function normalizeEntities(drafts: DraftEntity[]): NormalizedEntity[] {
  const relations = deriveRelationSides(drafts);
  validateImplicitNames(drafts, relations);

  return [...drafts].sort(byName).map((draft) => {
    const fields = [...draft.fields].sort(byName).map(normalizeField);
    const entityRelations = relations.get(draft.name) ?? [];

    // Every entity implicitly carries these columns; they are valid index fields.
    const implicitColumns = new Set(["id", "createdAt", "updatedAt"]);
    if (draft.softDelete) implicitColumns.add("deletedAt");

    for (const index of draft.indexes ?? []) {
      for (const fieldName of index.fields) {
        const knownField =
          implicitColumns.has(fieldName) || fields.some((field) => field.name === fieldName);
        const knownForeignKey = entityRelations.some(
          (relation) => relation.foreignKey === fieldName,
        );
        if (!knownField && !knownForeignKey) {
          throw new CompilerError(`Unknown index field '${fieldName}'`, [
            issue(
              "semantic.unknown-index-field",
              `/entities/${draft.name}/indexes`,
              `Indexed field '${fieldName}' does not exist on entity '${draft.name}'`,
            ),
          ]);
        }
      }
    }

    return {
      name: draft.name,
      description: draft.description ?? null,
      origin: draft.origin,
      ownerFeature: draft.ownerFeature ?? null,
      fields,
      relations: entityRelations,
      indexes: (draft.indexes ?? []).map((index) => ({
        fields: [...index.fields],
        unique: index.unique,
      })),
      crud: draft.crud ?? false,
      softDelete: draft.softDelete ?? false,
      ownership: draft.ownership ? { ...draft.ownership } : null,
      tenant: draft.tenant ? { ...draft.tenant } : null,
    };
  });
}

/**
 * Produces the base IR: entities only, with no feature semantics applied. The
 * full pipeline (`compileBackend`) layers feature contributions on top of this.
 */
export function compileSpec(spec: BackendSpec): BackendIR {
  return {
    irVersion: IR_VERSION,
    sourceSpecVersion: spec.specVersion,
    project: {
      name: spec.project.name,
      description: spec.project.description ?? null,
    },
    target: {
      id: spec.target.id,
      database: spec.target.database as Database,
    },
    entities: normalizeEntities(specToDrafts(spec)),
    features: [],
    endpoints: [],
    permissions: [],
    workflows: [],
    events: [],
    secrets: [],
    infrastructure: [
      {
        kind: "database",
        name: spec.target.database,
        feature: "core",
        reason: "Selected target database",
        portabilityNote: null,
      },
    ],
    customizationPoints: [],
  };
}
