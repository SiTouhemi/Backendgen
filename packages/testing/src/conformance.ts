import type { FeaturePack, FeatureRegistry } from "@backend-compiler/feature-sdk";
import {
  compileBackend,
  renderBackend,
  type TargetRegistry,
} from "@backend-compiler/generator-runtime";
import { SPEC_VERSION, type BackendSpec } from "@backend-compiler/specification";

/**
 * The entity set every conformance case is compiled against. It is deliberately
 * small and generic: a feature that needs more than this in order to render is a
 * feature that has leaked a specific domain into itself.
 */
export const CONFORMANCE_ENTITIES: BackendSpec["entities"] = {
  User: {
    fields: {
      displayName: { type: "string", required: true, minLength: 2, maxLength: 100 },
    },
  },
  Note: {
    fields: {
      title: { type: "string", required: true, maxLength: 200 },
      body: "text",
    },
  },
  Room: {
    fields: {
      number: { type: "string", required: true },
      capacity: { type: "integer", required: true, minimum: 1 },
    },
  },
};

export interface ConformanceResult {
  feature: string;
  case: string;
  passed: boolean;
  missingFiles: string[];
  missingEndpoints: string[];
  issues: Array<{ code: string; path: string; message: string }>;
}

/** Every feature the pack transitively depends on, with default configuration. */
function transitiveDependencies(
  pack: FeaturePack,
  registry: FeatureRegistry,
): Record<string, Record<string, unknown>> {
  const collected: Record<string, Record<string, unknown>> = {};
  const queue = [...pack.dependsOn];

  while (queue.length > 0) {
    const name = queue.shift() as string;

    if (name in collected) {
      continue;
    }

    collected[name] = {};
    const dependency = registry.get(name);

    if (dependency !== undefined) {
      queue.push(...dependency.dependsOn);
    }
  }

  return collected;
}

/**
 * Compiles and renders one conformance case, then checks that the endpoints and
 * files the feature promises actually exist. These cases are the black-box
 * contract a second target will have to satisfy too.
 */
export function runConformanceCase(input: {
  pack: FeaturePack;
  caseIndex: number;
  targetId: string;
  features: FeatureRegistry;
  targets: TargetRegistry;
}): ConformanceResult {
  const { pack, caseIndex, targetId, features, targets } = input;
  const conformance = pack.conformance[caseIndex];

  if (conformance === undefined) {
    throw new Error(`Feature '${pack.name}' has no conformance case at index ${caseIndex}`);
  }

  const spec: BackendSpec = {
    specVersion: SPEC_VERSION,
    project: { name: `conformance-${pack.name}` },
    target: { id: targetId, database: "postgresql" },
    entities: structuredClone(CONFORMANCE_ENTITIES),
    features: {
      ...transitiveDependencies(pack, features),
      ...(conformance.withFeatures ?? {}),
      [pack.name]: structuredClone(conformance.config),
    },
  };

  const compiled = compileBackend(spec, { features, targets });

  if (!compiled.ok) {
    return {
      feature: pack.name,
      case: conformance.name,
      passed: false,
      missingFiles: conformance.expectFiles,
      missingEndpoints: conformance.expectEndpoints,
      issues: compiled.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      })),
    };
  }

  const rendered = renderBackend(compiled.value);
  const paths = new Set(rendered.files.map((file) => file.path));
  const endpoints = new Set(compiled.value.ir.endpoints.map((endpoint) => endpoint.id));

  const missingFiles = conformance.expectFiles.filter((path) => !paths.has(path));
  const missingEndpoints = conformance.expectEndpoints.filter((id) => !endpoints.has(id));

  return {
    feature: pack.name,
    case: conformance.name,
    passed: missingFiles.length === 0 && missingEndpoints.length === 0,
    missingFiles,
    missingEndpoints,
    issues: [],
  };
}

export function runConformanceSuite(input: {
  targetId: string;
  features: FeatureRegistry;
  targets: TargetRegistry;
}): ConformanceResult[] {
  return input.features
    .forTarget(input.targetId)
    .flatMap((pack) =>
      pack.conformance.map((_, caseIndex) =>
        runConformanceCase({ ...input, pack, caseIndex }),
      ),
    );
}
