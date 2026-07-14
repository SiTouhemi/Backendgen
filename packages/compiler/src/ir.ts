import type { FieldType, RelationType } from "@backend-compiler/specification";

export const IR_VERSION = "backendcompiler.ir/v1" as const;

export type Database = "postgresql" | "mysql" | "sqlite";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The framework-independent intermediate representation. Every target adapter
 * consumes this and nothing else; no NestJS, Prisma or HTTP-framework concept is
 * allowed to appear here.
 */
export interface BackendIR {
  irVersion: typeof IR_VERSION;
  sourceSpecVersion: "backendcompiler.dev/v1";
  project: {
    name: string;
    description: string | null;
  };
  target: {
    id: string;
    database: Database;
  };
  entities: NormalizedEntity[];
  features: NormalizedFeature[];
  endpoints: EndpointDefinition[];
  permissions: PermissionRule[];
  workflows: WorkflowDefinition[];
  events: EventDefinition[];
  secrets: SecretDefinition[];
  infrastructure: InfrastructureRequirement[];
  customizationPoints: CustomizationPoint[];
}

export interface NormalizedEntity {
  name: string;
  description: string | null;
  /** `spec` entities come from the user; `feature` entities are created by a feature pack. */
  origin: "spec" | "feature";
  ownerFeature: string | null;
  fields: NormalizedField[];
  relations: NormalizedRelation[];
  indexes: NormalizedIndex[];
  /** Whether the CRUD feature exposes REST resources for this entity. */
  crud: boolean;
  softDelete: boolean;
  /** Row-level ownership: the relation pointing at the owning user entity. */
  ownership: EntityScope | null;
  /** Multi-tenant scoping: the relation pointing at the owning organization entity. */
  tenant: EntityScope | null;
}

export interface EntityScope {
  /** Relation field name on this entity, e.g. `owner`. */
  relation: string;
  /** Foreign key column implied by the relation, e.g. `ownerId`. */
  foreignKey: string;
  /** Target entity name, e.g. `User`. */
  entity: string;
}

export interface NormalizedField {
  name: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  description: string | null;
  /** Non-null when the field is a closed set of string values. */
  enumValues: string[] | null;
  /** Literal default applied by the datastore or the generated model. */
  defaultValue: string | number | boolean | null;
  /** Internal fields (password hashes, token digests) never appear in API DTOs. */
  internal: boolean;
  /** Fields the API never lets a client write, but which are readable. */
  readOnly: boolean;
  constraints: {
    minimum: number | null;
    maximum: number | null;
    minLength: number | null;
    maxLength: number | null;
  };
}

export interface NormalizedRelation {
  /** Field name on the entity that declares this side of the relation. */
  name: string;
  type: RelationType;
  target: string;
  required: boolean;
  /** `declared` sides come from the input; `derived` sides are the generated inverse. */
  origin: "declared" | "derived";
  /** Field name of the opposite side on the target entity. */
  inverseName: string;
  /** Stable identifier shared by both sides of the relation. */
  relationName: string;
  /** True when this side stores the foreign key. */
  owner: boolean;
  /** Foreign key field name, non-null only on the owning side of a to-one relation. */
  foreignKey: string | null;
  /** True for one-to-one relations, which constrain the foreign key to be unique. */
  unique: boolean;
}

export interface NormalizedIndex {
  fields: string[];
  unique: boolean;
}

export interface NormalizedFeature {
  name: string;
  version: string;
  options: Record<string, unknown>;
}

export interface EndpointDefinition {
  /** Stable identifier, e.g. `Room.list` or `auth.login`. */
  id: string;
  feature: string;
  method: HttpMethod;
  /** Route path using `:param` placeholders, e.g. `/rooms/:id`. */
  path: string;
  entity: string | null;
  operation: string;
  summary: string;
  auth: "public" | "authenticated";
  /** Empty means any authenticated principal; otherwise one of these roles is required. */
  roles: string[];
}

export interface PermissionRule {
  feature: string;
  entity: string;
  action: "create" | "read" | "list" | "update" | "delete";
  roles: string[];
  /** The caller must own the row (ownership relation points at the caller). */
  requiresOwnership: boolean;
  /** The row must belong to the caller's organization. */
  requiresTenant: boolean;
}

export interface WorkflowDefinition {
  name: string;
  feature: string;
  description: string;
  states: string[];
  initialState: string;
  terminalStates: string[];
  transitions: WorkflowTransition[];
}

export interface WorkflowTransition {
  from: string;
  to: string;
  trigger: string;
}

export interface EventDefinition {
  /** Dot-separated event name, e.g. `reservation.confirmed`. */
  name: string;
  feature: string;
  description: string;
  /** Payload field name to IR field type, kept framework-independent. */
  payload: Record<string, FieldType>;
}

export interface SecretDefinition {
  name: string;
  feature: string;
  description: string;
  required: boolean;
  /** Placeholder written into `.env.example`; never a real credential. */
  example: string;
}

export interface InfrastructureRequirement {
  kind: "database" | "database-extension" | "service" | "scheduler" | "cache";
  name: string;
  feature: string;
  reason: string;
  /** Set when the requirement is not portable across every supported database. */
  portabilityNote: string | null;
}

export interface CustomizationPoint {
  /** Path inside the generated project, e.g. `src/custom/reservation-policy.ts`. */
  path: string;
  feature: string;
  /** The interface or injection token the custom file implements. */
  contract: string;
  description: string;
}
