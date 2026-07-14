import { GENERATOR_NAME, GENERATOR_VERSION, type Issue } from "@backend-compiler/common";
import {
  compileBackend,
  createDefaultRegistry,
  createDefaultTargets,
  generateBackend,
  readManifest,
  runGeneratedTests,
  type TargetRegistry,
} from "@backend-compiler/generator-runtime";
import type { FeatureRegistry } from "@backend-compiler/feature-sdk";
import {
  loadSpecFile,
  SPEC_VERSION,
  validateSpec,
  type BackendSpec,
} from "@backend-compiler/specification";
import { IR_VERSION } from "@backend-compiler/compiler";
import { Sandbox } from "./sandbox.js";

/** Hard ceiling on how many paths any response may carry. Agents get counts, not dumps. */
const MAX_LISTED_PATHS = 40;

export interface ToolContext {
  sandbox: Sandbox;
  features: FeatureRegistry;
  targets: TargetRegistry;
}

export function createToolContext(sandbox: Sandbox): ToolContext {
  return {
    sandbox,
    features: createDefaultRegistry(),
    targets: createDefaultTargets(),
  };
}

export class ToolError extends Error {
  readonly issues: readonly Issue[];

  constructor(message: string, issues: readonly Issue[] = []) {
    super(message);
    this.name = "ToolError";
    this.issues = issues;
  }
}

const SPEC_INPUT = {
  specPath: {
    type: "string",
    description: "Path to a YAML or JSON specification, inside an allowed root.",
  },
  spec: {
    type: "object",
    description: "The specification inline, as an object. Use this or specPath, not both.",
  },
} as const;

export const TOOL_DEFINITIONS = [
  {
    name: "get_capabilities",
    description:
      "What this compiler can generate: specification version, targets, features and response limits. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_targets",
    description: "Backend targets this compiler can generate, with their supported databases.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_target",
    description: "Full detail for one target: databases, capabilities and project commands.",
    inputSchema: {
      type: "object",
      properties: { targetId: { type: "string" } },
      required: ["targetId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_features",
    description:
      "Feature packs available, with their dependencies and conflicts. Use describe_feature for the configuration schema.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_feature",
    description:
      "One feature's configuration JSON Schema, dependencies, conflicts and worked examples.",
    inputSchema: {
      type: "object",
      properties: { feature: { type: "string" } },
      required: ["feature"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_spec",
    description:
      "Validate a specification. Returns stable error codes and JSON pointers, so a failure can be fixed without guessing.",
    inputSchema: { type: "object", properties: SPEC_INPUT, additionalProperties: false },
  },
  {
    name: "inspect_spec",
    description:
      "Compile a specification and return the normalized backend IR: entities, endpoints, events, secrets and infrastructure.",
    inputSchema: { type: "object", properties: SPEC_INPUT, additionalProperties: false },
  },
  {
    name: "preview_generation",
    description:
      "Dry run: what generation would create, update, delete or refuse to overwrite. Writes nothing.",
    inputSchema: {
      type: "object",
      properties: { ...SPEC_INPUT, outputPath: { type: "string" } },
      required: ["outputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_backend",
    description:
      "Generate the backend. Refuses by default if a generated file was edited by hand; pass force to overwrite. Never overwrites src/custom/.",
    inputSchema: {
      type: "object",
      properties: {
        ...SPEC_INPUT,
        outputPath: { type: "string" },
        force: {
          type: "boolean",
          description: "Overwrite generated files that have local modifications.",
        },
      },
      required: ["outputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "run_generated_tests",
    description:
      "Run the generated project's test suites and return counts, not logs. Integration tests need a reachable database.",
    inputSchema: {
      type: "object",
      properties: {
        outputPath: { type: "string" },
        install: { type: "boolean", description: "Install dependencies first." },
        integration: { type: "boolean", description: "Also run the integration suite." },
      },
      required: ["outputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "get_generation_report",
    description:
      "Read the generation manifest of an already-generated project: versions, checksums and file ownership.",
    inputSchema: {
      type: "object",
      properties: { outputPath: { type: "string" } },
      required: ["outputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_customization_points",
    description:
      "Where to put custom code for a specification, and which interface each extension point expects.",
    inputSchema: { type: "object", properties: SPEC_INPUT, additionalProperties: false },
  },
] as const;

interface SpecArgs {
  specPath?: string;
  spec?: Record<string, unknown>;
}

async function loadSpec(context: ToolContext, args: SpecArgs): Promise<BackendSpec> {
  if (args.specPath !== undefined && args.spec !== undefined) {
    throw new ToolError("Provide either specPath or spec, not both");
  }

  const input =
    args.specPath !== undefined
      ? await loadSpecFile(context.sandbox.resolveInside(args.specPath))
      : args.spec;

  if (input === undefined) {
    throw new ToolError("Provide a specification with specPath or spec");
  }

  const result = validateSpec(input);

  if (!result.ok) {
    throw new ToolError(
      "Specification is invalid",
      result.issues.map((issue) => ({ ...issue, severity: "error" as const })),
    );
  }

  return result.value;
}

function compile(context: ToolContext, spec: BackendSpec) {
  const compiled = compileBackend(spec, {
    features: context.features,
    targets: context.targets,
  });

  if (!compiled.ok) {
    throw new ToolError("Specification is invalid", compiled.issues);
  }

  return compiled.value;
}

function capped(paths: readonly string[]): { paths: string[]; total: number; truncated: boolean } {
  return {
    paths: paths.slice(0, MAX_LISTED_PATHS),
    total: paths.length,
    truncated: paths.length > MAX_LISTED_PATHS,
  };
}

export async function callTool(
  context: ToolContext,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "get_capabilities":
      return {
        generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
        specVersion: SPEC_VERSION,
        irVersion: IR_VERSION,
        targets: context.targets.list().map((target) => ({
          id: target.id,
          version: target.version,
          databases: target.supportedDatabases,
        })),
        features: context.features.list().map((feature) => ({
          name: feature.name,
          version: feature.version,
          dependsOn: feature.dependsOn,
        })),
        limits: {
          maxListedPaths: MAX_LISTED_PATHS,
          fileContentsReturned: false,
          allowedRoots: context.sandbox.roots,
        },
        workflow: [
          "describe_feature to learn a feature's configuration",
          "validate_spec, then inspect_spec",
          "preview_generation, then generate_backend",
          "run_generated_tests",
        ],
      };

    case "list_targets":
      return context.targets.list().map((target) => ({
        id: target.id,
        version: target.version,
        description: target.description,
        databases: target.supportedDatabases,
        capabilities: target.capabilities,
      }));

    case "describe_target": {
      const id = String(rawArgs.targetId);
      const target = context.targets.get(id);

      if (target === undefined) {
        throw new ToolError(
          `Unknown target '${id}'. Available: ${context.targets.ids().join(", ")}`,
        );
      }

      return {
        id: target.id,
        version: target.version,
        description: target.description,
        databases: target.supportedDatabases,
        capabilities: target.capabilities,
        commands: target.commands,
      };
    }

    case "list_features":
      return context.features.list().map((feature) => ({
        name: feature.name,
        version: feature.version,
        description: feature.description,
        dependsOn: feature.dependsOn,
        conflictsWith: feature.conflictsWith,
        supportedTargets: feature.supportedTargets,
      }));

    case "describe_feature": {
      const name_ = String(rawArgs.feature);
      const feature = context.features.get(name_);

      if (feature === undefined) {
        throw new ToolError(
          `Unknown feature '${name_}'. Available: ${context.features.names().join(", ")}`,
        );
      }

      return {
        name: feature.name,
        version: feature.version,
        summary: feature.agentSummary,
        dependsOn: feature.dependsOn,
        conflictsWith: feature.conflictsWith,
        supportedTargets: feature.supportedTargets,
        configSchema: feature.configSchema,
        examples: feature.examples,
      };
    }

    case "validate_spec": {
      const spec = await loadSpec(context, rawArgs as SpecArgs);
      const compiled = compile(context, spec);

      return {
        valid: true,
        project: compiled.ir.project.name,
        target: compiled.ir.target.id,
        entities: compiled.ir.entities.length,
        features: compiled.ir.features.map((feature) => `${feature.name}@${feature.version}`),
        endpoints: compiled.ir.endpoints.length,
        specChecksum: compiled.specChecksum,
      };
    }

    case "inspect_spec": {
      const spec = await loadSpec(context, rawArgs as SpecArgs);
      const compiled = compile(context, spec);
      const { ir } = compiled;

      return {
        project: ir.project,
        target: ir.target,
        features: ir.features.map((feature) => ({
          name: feature.name,
          version: feature.version,
        })),
        entities: ir.entities.map((entity) => ({
          name: entity.name,
          origin: entity.origin,
          ownerFeature: entity.ownerFeature,
          fields: entity.fields.filter((field) => !field.internal).map((field) => field.name),
          relations: entity.relations.map((relation) => `${relation.name}->${relation.target}`),
          crud: entity.crud,
          softDelete: entity.softDelete,
          ownership: entity.ownership?.entity ?? null,
          tenant: entity.tenant?.entity ?? null,
        })),
        endpoints: ir.endpoints.map((endpoint) => ({
          id: endpoint.id,
          method: endpoint.method,
          path: endpoint.path,
          auth: endpoint.auth,
          roles: endpoint.roles,
        })),
        events: ir.events.map((event) => event.name),
        // Names only. A secret's value is never read, and never returned.
        secrets: ir.secrets.map((secret) => ({
          name: secret.name,
          required: secret.required,
          description: secret.description,
        })),
        infrastructure: ir.infrastructure.map((item) => ({
          kind: item.kind,
          name: item.name,
          portabilityNote: item.portabilityNote,
        })),
        workflows: ir.workflows,
        irChecksum: compiled.irChecksum,
      };
    }

    case "preview_generation":
    case "generate_backend": {
      const args = rawArgs as unknown as SpecArgs & { outputPath: string; force?: boolean };
      const spec = await loadSpec(context, args);
      const outputDirectory = context.sandbox.resolveInside(args.outputPath);

      const outcome = await generateBackend({
        spec,
        outputDirectory,
        features: context.features,
        targets: context.targets,
        dryRun: name === "preview_generation",
        force: args.force === true,
      });

      if (!outcome.ok) {
        throw new ToolError("Generation failed", outcome.issues);
      }

      const report = outcome.report;

      return {
        success: report.success,
        dryRun: report.dryRun,
        outputPath: report.outputPath,
        generatedFiles: report.generatedFiles,
        changes: report.changes,
        created: capped(report.created),
        updated: capped(report.updated),
        deleted: capped(report.deleted),
        preserved: report.preserved,
        conflicts: report.conflicts,
        warnings: report.warnings,
        customizationPoints: report.customizationPoints,
        target: report.target,
        features: report.features,
        entities: report.entities,
        endpoints: report.endpoints,
        specChecksum: report.specChecksum,
        nextSteps: report.nextSteps,
      };
    }

    case "run_generated_tests": {
      const args = rawArgs as unknown as {
        outputPath: string;
        install?: boolean;
        integration?: boolean;
      };
      const outputDirectory = context.sandbox.resolveInside(args.outputPath);

      const result = await runGeneratedTests({
        outputDirectory,
        install: args.install === true,
        integration: args.integration === true,
      });

      return {
        success: result.success,
        tests: result.tests,
        commands: result.commands.map((command) => ({
          command: command.command,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
        })),
        // Only the failing output, and only a bounded slice of it.
        failureOutput:
          result.commands
            .find((command) => command.exitCode !== 0)
            ?.output.slice(-4000) ?? null,
      };
    }

    case "get_generation_report": {
      const outputDirectory = context.sandbox.resolveInside(
        String((rawArgs as { outputPath: string }).outputPath),
      );

      const manifest = await readManifest(outputDirectory);

      if (manifest === null) {
        throw new ToolError(
          `No generation manifest at '${outputDirectory}'. Run generate_backend first.`,
        );
      }

      const custom = manifest.files.filter((file) => file.ownership === "custom-scaffold");

      return {
        outputPath: outputDirectory,
        generator: manifest.generator,
        target: manifest.target,
        features: manifest.features,
        specChecksum: manifest.specChecksum,
        irChecksum: manifest.irChecksum,
        files: {
          total: manifest.files.length,
          generated: manifest.files.length - custom.length,
          customScaffold: custom.length,
        },
        customFiles: custom.map((file) => file.path),
      };
    }

    case "explain_customization_points": {
      const spec = await loadSpec(context, rawArgs as SpecArgs);
      const compiled = compile(context, spec);

      return {
        rules: [
          "src/generated/ is owned by the compiler and is replaced on every generation.",
          "src/custom/ is yours. It is written once and never overwritten, even with force.",
          "Generation refuses by default if a file under src/generated/ was edited by hand.",
          "To change generated behaviour, implement the named interface and provide it in src/custom/custom.module.ts. CustomModule is imported last, so a custom provider wins.",
        ],
        points: compiled.ir.customizationPoints.map((point) => ({
          path: point.path,
          feature: point.feature,
          contract: point.contract,
          description: point.description,
        })),
        events: compiled.ir.events.map((event) => ({
          name: event.name,
          description: event.description,
          payload: event.payload,
        })),
      };
    }

    default:
      throw new ToolError(`Unknown tool '${name}'`);
  }
}
