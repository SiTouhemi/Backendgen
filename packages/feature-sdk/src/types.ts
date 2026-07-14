import type {
  BackendIR,
  CustomizationPoint,
  Database,
  DraftEntity,
  EndpointDefinition,
  EntityPatch,
  EventDefinition,
  InfrastructureRequirement,
  NormalizedEntity,
  PermissionRule,
  SecretDefinition,
  WorkflowDefinition,
} from "@backend-compiler/compiler";
import type { FeatureTargetRenderer } from "@backend-compiler/target-sdk";

/** A JSON Schema document describing a feature's configuration object. */
export type JsonSchema = Record<string, unknown>;

export interface FeatureEntityContext {
  featureName: string;
  /** Configuration after JSON Schema validation and default application. */
  config: Record<string, unknown>;
  target: { id: string; database: Database };
  /** Entity names declared by the user, in stable order. */
  specEntities: readonly string[];
  /** Configuration of another selected feature, or `undefined` when absent. */
  featureConfig(name: string): Record<string, unknown> | undefined;
}

export interface FeatureEntityContribution {
  /** Entities this feature owns and creates. */
  create?: DraftEntity[];
  /** Extensions applied to entities owned by the user or by an earlier feature. */
  patch?: EntityPatch[];
}

export interface FeatureContext extends FeatureEntityContext {
  /** Entities after every feature's entity contribution has been normalised. */
  entities: readonly NormalizedEntity[];
  entity(name: string): NormalizedEntity;
  crudEntities(): NormalizedEntity[];
}

export interface FeatureContribution {
  endpoints?: EndpointDefinition[];
  permissions?: PermissionRule[];
  events?: EventDefinition[];
  workflows?: WorkflowDefinition[];
  secrets?: SecretDefinition[];
  infrastructure?: InfrastructureRequirement[];
  customizationPoints?: CustomizationPoint[];
}

/**
 * A conformance case is a black-box contract: with this configuration, on a
 * supported target, the named files and endpoints must exist. The same cases run
 * against every future target, which is what keeps feature semantics portable.
 */
export interface ConformanceCase {
  name: string;
  description: string;
  config: Record<string, unknown>;
  /**
   * Extra features the case needs beyond this pack's declared dependencies —
   * for example a notification case that subscribes to an authentication event.
   */
  withFeatures?: Record<string, Record<string, unknown>>;
  expectFiles: string[];
  expectEndpoints: string[];
}

export interface FeaturePack {
  name: string;
  /** Semantic version of the pack itself, recorded in the generation manifest. */
  version: string;
  description: string;
  configSchema: JsonSchema;
  dependsOn: readonly string[];
  conflictsWith: readonly string[];
  supportedTargets: readonly string[];
  /** Entities that must already exist for this configuration to be valid. */
  requiredEntities(config: Record<string, unknown>): readonly string[];
  /** Phase 1: create and extend entities. Runs before normalisation. */
  contributeEntities(context: FeatureEntityContext): FeatureEntityContribution;
  /** Phase 2: contribute endpoints, events, secrets and infrastructure to the IR. */
  contribute(context: FeatureContext): FeatureContribution;
  /** Phase 3: target-specific rendering, keyed by target id. */
  renderers: Record<string, FeatureTargetRenderer>;
  /** Concise description for agents; kept small on purpose. */
  agentSummary: string;
  examples: Array<{ name: string; config: Record<string, unknown> }>;
  conformance: ConformanceCase[];
  /** Optional cross-feature validation the JSON Schema cannot express. */
  validate?(context: FeatureEntityContext): ReadonlyArray<{ code: string; path: string; message: string }>;
}

export interface ResolvedFeature {
  pack: FeaturePack;
  config: Record<string, unknown>;
}

export type { BackendIR };
