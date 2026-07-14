export { compileBackend } from "./compile.js";
export type { CompileOptions, CompileOutcome, CompiledBackend } from "./compile.js";
export { diffBackend, generateBackend } from "./generate.js";
export type { GenerateOptions, GenerateOutcome, GenerationReport } from "./generate.js";
export {
  createManifest,
  hashContents,
  MANIFEST_PATH,
  MANIFEST_VERSION,
  readManifest,
  serializeManifest,
} from "./manifest.js";
export type { GenerationManifest, ManifestFile } from "./manifest.js";
export {
  assertSafeRelativePath,
  planGeneration,
  summarizePlan,
} from "./plan.js";
export type { FileAction, FileConflict, GenerationPlan, PlannedFile } from "./plan.js";
export { createDefaultRegistry, createDefaultTargets, TargetRegistry } from "./registries.js";
export { renderBackend } from "./render.js";
export { parseJestSummary, runGeneratedTests } from "./run-tests.js";
export type {
  CommandResult,
  RunTestsOptions,
  RunTestsResult,
  TestSummary,
} from "./run-tests.js";
