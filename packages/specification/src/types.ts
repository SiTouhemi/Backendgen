export const SPEC_VERSION = "backendcompiler.dev/v1" as const;

export type FieldType =
  | "string"
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "datetime"
  | "date"
  | "uuid";

export interface FieldOptions {
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** Closed set of allowed string values; renders as a native enum where the target supports one. */
  enum?: string[];
  default?: string | number | boolean;
}

export type FieldDefinition = FieldType | FieldOptions;

export type RelationType = "belongsTo" | "hasOne" | "hasMany" | "manyToMany";

export type RelationOnDelete = "restrict" | "cascade" | "setNull";

export interface RelationDefinition {
  name: string;
  type: RelationType;
  target: string;
  /**
   * Whether the owning foreign key is non-null. Applies only to `belongsTo`
   * and `hasOne`; collection relations must omit it.
   */
  required?: boolean;
  /**
   * Referential action for the owning foreign key. For `belongsTo`/`hasOne`,
   * deleting the target applies the action to this row. For `hasMany`, deleting
   * this row applies it to the derived foreign key on the target rows.
   * `manyToMany` must model a join entity explicitly to control deletion.
   */
  onDelete?: RelationOnDelete;
}

export interface IndexDefinition {
  fields: string[];
  unique?: boolean;
}

export interface EntityDefinition {
  description?: string;
  fields: Record<string, FieldDefinition>;
  relations?: RelationDefinition[];
  indexes?: IndexDefinition[];
}

export interface ProjectOptions {
  /** Route prefix for every generated HTTP endpoint. Defaults to `api`. */
  apiPrefix?: string;
  /** Default HTTP port written into generated configuration. Defaults to 3000. */
  port?: number;
  /** Emit the typed API client under `client/`. Defaults to true. */
  client?: boolean;
}

export interface BackendSpec {
  specVersion: typeof SPEC_VERSION;
  project: {
    name: string;
    description?: string;
  };
  target: {
    id: string;
    database: "postgresql" | "mysql" | "sqlite";
  };
  entities: Record<string, EntityDefinition>;
  features: Record<string, Record<string, unknown>>;
  options?: ProjectOptions;
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: BackendSpec }
  | { ok: false; issues: ValidationIssue[] };
