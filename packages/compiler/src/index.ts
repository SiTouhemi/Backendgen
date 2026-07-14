export {
  applyEntityContributions,
  compileSpec,
  normalizeEntities,
  specToDrafts,
} from "./compile.js";
export { IR_VERSION } from "./ir.js";
export type { DraftEntity, DraftField, DraftRelation, EntityPatch } from "./drafts.js";
export type {
  BackendIR,
  CustomizationPoint,
  Database,
  EndpointDefinition,
  EntityScope,
  EventDefinition,
  HttpMethod,
  InfrastructureRequirement,
  NormalizedEntity,
  NormalizedFeature,
  NormalizedField,
  NormalizedIndex,
  NormalizedRelation,
  PermissionRule,
  SecretDefinition,
  WorkflowDefinition,
  WorkflowTransition,
} from "./ir.js";
