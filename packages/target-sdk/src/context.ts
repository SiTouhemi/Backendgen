import { CompilerError, issue } from "@backend-compiler/common";
import type { BackendIR, NormalizedEntity } from "@backend-compiler/compiler";
import type { ProjectSettings, RenderResult, RenderedFile, TargetRenderContext } from "./types.js";

export function emptyRenderResult(): RenderResult {
  return {
    files: [],
    rootModules: [],
    packageDependencies: {},
    packageDevDependencies: {},
    scripts: {},
    migrationSql: [],
    envExample: [],
    testEnv: {},
  };
}

function dedupeFiles(files: RenderedFile[]): RenderedFile[] {
  const byPath = new Map<string, RenderedFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing && existing.contents !== file.contents) {
      throw new CompilerError(`Conflicting output for '${file.path}'`, [
        issue(
          "render.file-conflict",
          `/${file.path}`,
          `Two renderers produced different contents for '${file.path}'`,
        ),
      ]);
    }
    byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Merges renderer output deterministically. Files are de-duplicated by path and
 * sorted; identical duplicates are allowed (two features may both need the same
 * shared helper) but conflicting ones fail loudly rather than silently winning.
 */
export function mergeRenderResults(results: readonly RenderResult[]): RenderResult {
  const merged = emptyRenderResult();

  const mergeRecord = (
    destination: Record<string, string>,
    source: Record<string, string>,
    kind: "dependency" | "dev-dependency" | "script" | "test-env",
  ): void => {
    for (const [name, value] of Object.entries(source)) {
      const existing = destination[name];
      if (existing !== undefined && existing !== value) {
        throw new CompilerError(`Conflicting ${kind} '${name}'`, [
          issue(
            `render.${kind}-conflict`,
            `/${kind}/${name}`,
            `Renderers requested incompatible values '${existing}' and '${value}' for '${name}'`,
          ),
        ]);
      }
      destination[name] = value;
    }
  };

  for (const result of results) {
    merged.files.push(...result.files);
    merged.rootModules.push(...result.rootModules);
    mergeRecord(merged.packageDependencies, result.packageDependencies, "dependency");
    mergeRecord(merged.packageDevDependencies, result.packageDevDependencies, "dev-dependency");
    mergeRecord(merged.scripts, result.scripts, "script");
    merged.migrationSql.push(...result.migrationSql);
    merged.envExample.push(...result.envExample);
    mergeRecord(merged.testEnv, result.testEnv, "test-env");
  }

  merged.files = dedupeFiles(merged.files);
  merged.rootModules = [...merged.rootModules]
    .filter(
      (module, index, all) =>
        all.findIndex((other) => other.symbol === module.symbol && other.kind === module.kind) ===
        index,
    )
    .sort((left, right) =>
      left.order !== right.order ? left.order - right.order : left.symbol < right.symbol ? -1 : 1,
    );
  merged.envExample = merged.envExample.filter(
    (entry, index, all) => all.findIndex((other) => other.name === entry.name) === index,
  );

  return merged;
}

export function createRenderContext(input: {
  ir: BackendIR;
  targetId: string;
  settings: ProjectSettings;
  config?: Record<string, unknown>;
}): TargetRenderContext {
  const { ir, targetId, settings } = input;
  const entities = new Map(ir.entities.map((entity) => [entity.name, entity]));
  const features = new Map(ir.features.map((feature) => [feature.name, feature.options]));

  return {
    ir,
    targetId,
    database: ir.target.database,
    settings,
    config: input.config ?? {},
    hasFeature: (name) => features.has(name),
    featureConfig: (name) => features.get(name),
    entity: (name): NormalizedEntity => {
      const entity = entities.get(name);
      if (!entity) {
        throw new CompilerError(`Unknown entity '${name}'`, [
          issue("render.unknown-entity", `/entities/${name}`, `Entity '${name}' is not in the IR`),
        ]);
      }
      return entity;
    },
    crudEntities: () => ir.entities.filter((entity) => entity.crud),
  };
}
