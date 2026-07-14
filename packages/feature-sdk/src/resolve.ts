import { issue, type Issue } from "@backend-compiler/common";
import type { Database } from "@backend-compiler/compiler";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { FeatureRegistry } from "./registry.js";
import type { FeaturePack, ResolvedFeature } from "./types.js";

export interface ResolveInput {
  registry: FeatureRegistry;
  /** Feature name to raw configuration, exactly as written in the specification. */
  requested: Record<string, Record<string, unknown>>;
  target: { id: string; database: Database };
  specEntities: readonly string[];
}

export type ResolveResult =
  | { ok: true; features: ResolvedFeature[] }
  | { ok: false; issues: Issue[] };

function configIssue(featureName: string, error: ErrorObject): Issue {
  const missingProperty =
    error.keyword === "required" && "missingProperty" in error.params
      ? `/${String(error.params.missingProperty)}`
      : "";

  return issue(
    `feature-config.${error.keyword}`,
    `/features/${featureName}${error.instancePath}${missingProperty}`,
    error.message ?? "Invalid feature configuration",
  );
}

/**
 * Topological sort with an alphabetical tie-break. Two runs over the same
 * feature set always produce the same order, which is a prerequisite for
 * byte-stable generation.
 */
function orderFeatures(
  names: readonly string[],
  registry: FeatureRegistry,
): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const selected = new Set(names);
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (name: string): string[] | null => {
    const status = state.get(name);
    if (status === "done") return null;
    if (status === "visiting") {
      const start = stack.indexOf(name);
      return [...stack.slice(start), name];
    }

    state.set(name, "visiting");
    stack.push(name);

    const pack = registry.get(name);
    const dependencies = [...(pack?.dependsOn ?? [])]
      .filter((dependency) => selected.has(dependency))
      .sort();

    for (const dependency of dependencies) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }

    stack.pop();
    state.set(name, "done");
    order.push(name);
    return null;
  };

  for (const name of [...names].sort()) {
    const cycle = visit(name);
    if (cycle) {
      return { ok: false, cycle };
    }
  }

  return { ok: true, order };
}

/**
 * Validates and orders the requested feature set. Every failure mode the
 * milestone requires — unknown feature, missing dependency, cycle, conflict,
 * unsupported target, invalid configuration, missing entity — produces a stable
 * code and a JSON pointer into the specification.
 */
export function resolveFeatures(input: ResolveInput): ResolveResult {
  const { registry, requested, target, specEntities } = input;
  const issues: Issue[] = [];
  const requestedNames = Object.keys(requested).sort();

  const known = requestedNames.filter((name) => {
    if (!registry.has(name)) {
      issues.push(
        issue(
          "feature.unknown",
          `/features/${name}`,
          `Unknown feature '${name}'. Available features: ${registry.names().join(", ")}`,
        ),
      );
      return false;
    }
    return true;
  });

  const selected = new Set(known);

  for (const name of known) {
    const pack = registry.get(name)!;

    for (const dependency of [...pack.dependsOn].sort()) {
      if (!selected.has(dependency)) {
        issues.push(
          issue(
            "feature.missing-dependency",
            `/features/${name}`,
            `Feature '${name}' requires feature '${dependency}'. Add '${dependency}: {}' to the features block.`,
          ),
        );
      }
    }

    for (const conflict of [...pack.conflictsWith].sort()) {
      if (selected.has(conflict)) {
        issues.push(
          issue(
            "feature.conflict",
            `/features/${name}`,
            `Feature '${name}' is incompatible with feature '${conflict}'`,
          ),
        );
      }
    }

    if (!pack.supportedTargets.includes(target.id)) {
      issues.push(
        issue(
          "feature.unsupported-target",
          `/features/${name}`,
          `Feature '${name}' does not support target '${target.id}'. Supported targets: ${pack.supportedTargets.join(", ")}`,
        ),
      );
    }
  }

  const ordering = orderFeatures(known, registry);
  if (!ordering.ok) {
    issues.push(
      issue(
        "feature.circular-dependency",
        "/features",
        `Circular feature dependency: ${ordering.cycle.join(" -> ")}`,
      ),
    );
    return { ok: false, issues };
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
  const configs = new Map<string, Record<string, unknown>>();

  for (const name of ordering.order) {
    const pack = registry.get(name)!;
    const config = structuredClone(requested[name] ?? {});
    const validate = ajv.compile(pack.configSchema);

    if (!validate(config)) {
      for (const error of validate.errors ?? []) {
        issues.push(configIssue(name, error));
      }
      continue;
    }

    configs.set(name, config);
  }

  const entityNames = new Set(specEntities);
  const featureConfig = (name: string): Record<string, unknown> | undefined => configs.get(name);

  for (const name of ordering.order) {
    const pack = registry.get(name);
    const config = configs.get(name);
    if (!pack || !config) continue;

    for (const entity of pack.requiredEntities(config)) {
      if (!entityNames.has(entity)) {
        issues.push(
          issue(
            "feature.missing-entity",
            `/features/${name}`,
            `Feature '${name}' requires entity '${entity}', which is not defined in the specification`,
          ),
        );
      }
    }

    for (const custom of pack.validate?.({
      featureName: name,
      config,
      target,
      specEntities,
      featureConfig,
    }) ?? []) {
      issues.push(issue(custom.code, custom.path, custom.message));
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const features: ResolvedFeature[] = ordering.order.map((name) => ({
    pack: registry.get(name) as FeaturePack,
    config: configs.get(name)!,
  }));

  return { ok: true, features };
}
