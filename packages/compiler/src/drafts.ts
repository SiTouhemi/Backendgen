import type { FieldType, RelationType } from "@backend-compiler/specification";
import type { EntityScope, NormalizedIndex } from "./ir.js";

/**
 * Drafts are the mutable authoring shape used between parsing and normalisation.
 * Both the user specification and feature packs are lowered into drafts, so a
 * single normaliser produces the IR for everything.
 */
export interface DraftField {
  name: string;
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  description?: string;
  enumValues?: string[];
  defaultValue?: string | number | boolean;
  internal?: boolean;
  readOnly?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface DraftRelation {
  name: string;
  type: RelationType;
  target: string;
  required?: boolean;
  /** Override the generated field name on the opposite entity. */
  inverseName?: string;
  /** Override the generated foreign key name on the owning entity. */
  foreignKey?: string;
}

export interface DraftEntity {
  name: string;
  description?: string;
  origin: "spec" | "feature";
  ownerFeature?: string;
  fields: DraftField[];
  relations?: DraftRelation[];
  indexes?: NormalizedIndex[];
  crud?: boolean;
  softDelete?: boolean;
  ownership?: EntityScope;
  tenant?: EntityScope;
}

/**
 * A patch lets one feature extend an entity owned by the user or by another
 * feature (auth adds `passwordHash` to `User`; organizations adds an
 * `organization` relation to every tenant-scoped entity).
 */
export interface EntityPatch {
  entity: string;
  addFields?: DraftField[];
  addRelations?: DraftRelation[];
  addIndexes?: NormalizedIndex[];
  crud?: boolean;
  softDelete?: boolean;
  ownership?: EntityScope | null;
  tenant?: EntityScope | null;
}
