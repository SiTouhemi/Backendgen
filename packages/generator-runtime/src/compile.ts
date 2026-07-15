import { canonicalJson, CompilerError, issue, sha256, type Issue } from "@backend-compiler/common";
import {
  applyEntityContributions,
  IR_VERSION,
  normalizeEntities,
  specToDrafts,
  type BackendIR,
  type CustomizationPoint,
  type Database,
  type DraftEntity,
  type EndpointDefinition,
  type EntityPatch,
  type EventDefinition,
  type InfrastructureRequirement,
  type NormalizedEntity,
  type PermissionRule,
  type SecretDefinition,
  type WorkflowDefinition,
} from "@backend-compiler/compiler";
import {
  resolveFeatures,
  type FeatureContext,
  type FeatureEntityContext,
  type FeatureRegistry,
  type ResolvedFeature,
} from "@backend-compiler/feature-sdk";
import type { BackendSpec } from "@backend-compiler/specification";
import type { ProjectSettings, TargetAdapter } from "@backend-compiler/target-sdk";
import type { TargetRegistry } from "./registries.js";

export interface CompileOptions {
  features: FeatureRegistry;
  targets: TargetRegistry;
}

export interface CompiledBackend {
  ir: BackendIR;
  target: TargetAdapter;
  features: ResolvedFeature[];
  settings: ProjectSettings;
  /** Checksum of the input specification, recorded in the generation manifest. */
  specChecksum: string;
  irChecksum: string;
}

export type CompileOutcome =
  | { ok: true; value: CompiledBackend }
  | { ok: false; issues: Issue[] };

const DEFAULT_SETTINGS: ProjectSettings = { apiPrefix: "api", port: 3000, client: true };

function projectSettings(spec: BackendSpec): ProjectSettings {
  return {
    apiPrefix: spec.options?.apiPrefix ?? DEFAULT_SETTINGS.apiPrefix,
    port: spec.options?.port ?? DEFAULT_SETTINGS.port,
    client: spec.options?.client ?? DEFAULT_SETTINGS.client,
  };
}

function sortByKey<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
}

function dedupeByKey<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }

  return result;
}

/**
 * The whole compilation pipeline: validate the feature set, let every feature
 * shape the entities, normalise, let every feature contribute semantics, then
 * hand the result to the target for a final target-specific check.
 *
 * It is a pure function of the specification and the registries, which is what
 * makes byte-identical regeneration possible.
 */
export function compileBackend(spec: BackendSpec, options: CompileOptions): CompileOutcome {
  const target = options.targets.get(spec.target.id);

  if (target === undefined) {
    return {
      ok: false,
      issues: [
        issue(
          "target.unknown",
          "/target/id",
          `Unknown target '${spec.target.id}'. Available targets: ${options.targets.ids().join(", ")}`,
        ),
      ],
    };
  }

  const database = spec.target.database as Database;

  if (!target.supportedDatabases.includes(database)) {
    return {
      ok: false,
      issues: [
        issue(
          "target.unsupported-database",
          "/target/database",
          `Target '${target.id}' supports ${target.supportedDatabases.join(", ")}; got '${database}'`,
        ),
      ],
    };
  }

  const specEntities = Object.keys(spec.entities).sort();

  const resolved = resolveFeatures({
    registry: options.features,
    requested: spec.features,
    target: { id: target.id, database },
    specEntities,
  });

  if (!resolved.ok) {
    return { ok: false, issues: resolved.issues };
  }

  const configOf = (name: string): Record<string, unknown> | undefined =>
    resolved.features.find((feature) => feature.pack.name === name)?.config;

  const entityContext = (feature: ResolvedFeature): FeatureEntityContext => ({
    featureName: feature.pack.name,
    config: feature.config,
    target: { id: target.id, database },
    specEntities,
    featureConfig: configOf,
  });

  const created: DraftEntity[] = [];
  const patches: EntityPatch[] = [];

  try {
    for (const feature of resolved.features) {
      const contribution = feature.pack.contributeEntities(entityContext(feature));
      created.push(...(contribution.create ?? []));
      patches.push(...(contribution.patch ?? []));
    }

    const entities: NormalizedEntity[] = normalizeEntities(
      applyEntityContributions(specToDrafts(spec), created, patches),
    );

    const endpoints: EndpointDefinition[] = [];
    const permissions: PermissionRule[] = [];
    const events: EventDefinition[] = [];
    const workflows: WorkflowDefinition[] = [];
    const secrets: SecretDefinition[] = [];
    const infrastructure: InfrastructureRequirement[] = [
      {
        kind: "database",
        name: database,
        feature: "core",
        reason: "Selected target database",
        portabilityNote: null,
      },
    ];
    const customizationPoints: CustomizationPoint[] = [];

    const entityByName = new Map(entities.map((entity) => [entity.name, entity]));

    for (const feature of resolved.features) {
      const context: FeatureContext = {
        ...entityContext(feature),
        entities,
        entity: (name: string): NormalizedEntity => {
          const entity = entityByName.get(name);
          if (entity === undefined) {
            throw new CompilerError(`Unknown entity '${name}'`, [
              issue(
                "feature.missing-entity",
                `/features/${feature.pack.name}`,
                `Feature '${feature.pack.name}' referenced unknown entity '${name}'`,
              ),
            ]);
          }
          return entity;
        },
        crudEntities: () => entities.filter((entity) => entity.crud),
      };

      const contribution = feature.pack.contribute(context);
      endpoints.push(...(contribution.endpoints ?? []));
      permissions.push(...(contribution.permissions ?? []));
      events.push(...(contribution.events ?? []));
      workflows.push(...(contribution.workflows ?? []));
      secrets.push(...(contribution.secrets ?? []));
      infrastructure.push(...(contribution.infrastructure ?? []));
      customizationPoints.push(...(contribution.customizationPoints ?? []));
    }

    const ir: BackendIR = {
      irVersion: IR_VERSION,
      sourceSpecVersion: spec.specVersion,
      project: {
        name: spec.project.name,
        description: spec.project.description ?? null,
      },
      target: { id: target.id, database },
      entities,
      features: resolved.features.map((feature) => ({
        name: feature.pack.name,
        version: feature.pack.version,
        options: structuredClone(feature.config),
      })),
      endpoints: sortByKey(endpoints, (endpoint) => `${endpoint.id}:${endpoint.method}`),
      permissions: sortByKey(permissions, (rule) => `${rule.entity}:${rule.action}`),
      workflows: sortByKey(workflows, (workflow) => workflow.name),
      events: sortByKey(dedupeByKey(events, (event) => event.name), (event) => event.name),
      secrets: sortByKey(dedupeByKey(secrets, (secret) => secret.name), (secret) => secret.name),
      infrastructure: sortByKey(
        dedupeByKey(infrastructure, (requirement) => `${requirement.kind}:${requirement.name}`),
        (requirement) => `${requirement.kind}:${requirement.name}`,
      ),
      customizationPoints: sortByKey(
        dedupeByKey(customizationPoints, (point) => point.path),
        (point) => point.path,
      ),
    };

    const targetIssues = target.validate(ir);
    if (targetIssues.some((item) => item.severity === "error")) {
      return { ok: false, issues: targetIssues };
    }

    return {
      ok: true,
      value: {
        ir,
        target,
        features: resolved.features,
        settings: projectSettings(spec),
        specChecksum: `sha256:${sha256(canonicalJson(spec))}`,
        irChecksum: `sha256:${sha256(canonicalJson(ir))}`,
      },
    };
  } catch (error) {
    if (error instanceof CompilerError) {
      return { ok: false, issues: [...error.issues] };
    }
    throw error;
  }
}
