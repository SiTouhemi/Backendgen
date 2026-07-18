#!/usr/bin/env node
import { CompilerError, GENERATOR_VERSION, type Issue } from "@backend-compiler/common";
import {
  compileBackend,
  createDefaultRegistry,
  createDefaultTargets,
  generateBackend,
  runGeneratedTests,
} from "@backend-compiler/generator-runtime";
import {
  loadSpecFile,
  PUBLIC_SCHEMA_NAMES,
  PUBLIC_SCHEMAS,
  validateSpec,
  type BackendSpec,
  type PublicSchemaName,
} from "@backend-compiler/specification";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  formatFeature,
  formatFeatures,
  formatIssues,
  formatReport,
  formatSummary,
  formatTarget,
  formatTargets,
} from "./format.js";

const HELP = `backendgen — deterministic backend feature compiler

Usage:
  backendgen --version
  backendgen init [path] [--name <project-name>]
  backendgen list-targets [--json]
  backendgen describe-target <target-id> [--json]
  backendgen list-features [--json]
  backendgen describe-feature <feature> [--json]
  backendgen validate <spec.yaml> [--json]
  backendgen inspect <spec.yaml> [--json]
  backendgen generate <spec.yaml> --output <dir> [--dry-run] [--force] [--allow-destructive]
                      [--accept-manual <migration-dir>] [--json]
  backendgen diff <spec.yaml> --output <dir> [--allow-destructive] [--accept-manual <migration-dir>] [--json]
  backendgen test-generated --output <dir> [--install] [--integration] [--json]
  backendgen export-schema <spec|frontend> [--output <file.json>] [--json]

Exit codes:
  0  success
  1  validation, generation, build or test failure
`;

class CliError extends Error {
  readonly issues: readonly Issue[];

  constructor(message: string, issues: readonly Issue[] = []) {
    super(message);
    this.issues = issues;
  }
}

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = rest[index + 1];

    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { command, positional, flags };
}

function requireFlag(args: Args, name: string): string {
  const value = args.flags.get(name);

  if (typeof value !== "string") {
    throw new CliError(`Missing required option --${name}`);
  }

  return value;
}

function write(json: boolean, structured: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(structured, null, 2)}\n` : `${text}\n`);
}

function starterSpec(projectName: string): string {
  return `specVersion: backendcompiler.dev/v1

project:
  name: ${projectName}
  description: Describe what this backend does

target:
  id: nestjs-prisma
  database: postgresql

entities:
  Note:
    fields:
      title:
        type: string
        required: true
        maxLength: 200
      body: string

# Enable features here. Run \`backendgen list-features\` for the catalog and
# \`backendgen describe-feature <name>\` for each feature's options.
features:
  crud: {}

  # auth:
  #   methods: [email_password]
  #   roles: [admin, member]

  # organizations: {}

  # reservations:
  #   resource: Note
  #   owner: User
  #   preventOverlap: true
`;
}

function validateStarterProjectName(projectName: string): void {
  const candidate: BackendSpec = {
    specVersion: "backendcompiler.dev/v1",
    project: { name: projectName },
    target: { id: "nestjs-prisma", database: "postgresql" },
    entities: {
      Note: {
        fields: {
          title: { type: "string", required: true, maxLength: 200 },
          body: "string",
        },
      },
    },
    features: { crud: {} },
  };
  const validation = validateSpec(candidate);

  if (!validation.ok) {
    throw new CliError(
      `Invalid project name '${projectName}'`,
      validation.issues.map((item) => ({ ...item, severity: "error" as const })),
    );
  }
}

async function loadAndValidate(filePath: string): Promise<{ path: string; spec: BackendSpec }> {
  const absolute = resolve(process.cwd(), filePath);
  const input = await loadSpecFile(absolute);
  const result = validateSpec(input);

  if (!result.ok) {
    throw new CliError(
      "Specification is invalid",
      result.issues.map((item) => ({ ...item, severity: "error" as const })),
    );
  }

  return { path: absolute, spec: result.value };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const json = args.flags.get("json") === true;
  const features = createDefaultRegistry();
  const targets = createDefaultTargets();

  switch (args.command) {
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(`${GENERATOR_VERSION}\n`);
      return;

    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(HELP);
      return;
    }

    case "init": {
      const destination = resolve(process.cwd(), args.positional[0] ?? "backend.yaml");
      const nameFlag = args.flags.get("name");
      const projectName = typeof nameFlag === "string" ? nameFlag : "my-api";

      const exists = await access(destination)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        throw new CliError(`Refusing to overwrite existing file: ${destination}`);
      }

      validateStarterProjectName(projectName);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, starterSpec(projectName), "utf8");
      write(
        json,
        { created: destination },
        `Created ${destination}\n\nNext steps:\n` +
          `  backendgen validate ${args.positional[0] ?? "backend.yaml"}\n` +
          `  backendgen generate ${args.positional[0] ?? "backend.yaml"} --output ./my-api\n\n` +
          "Run `backendgen list-features` to see what you can enable.",
      );
      return;
    }

    case "list-targets": {
      const list = targets.list();
      write(
        json,
        list.map((target) => ({
          id: target.id,
          version: target.version,
          description: target.description,
          databases: target.supportedDatabases,
          capabilities: target.capabilities,
        })),
        formatTargets(list),
      );
      return;
    }

    case "describe-target": {
      const id = args.positional[0];
      if (id === undefined) throw new CliError("describe-target requires a target id");

      const target = targets.get(id);
      if (target === undefined) {
        throw new CliError(`Unknown target '${id}'. Available: ${targets.ids().join(", ")}`);
      }

      write(
        json,
        {
          id: target.id,
          version: target.version,
          description: target.description,
          databases: target.supportedDatabases,
          capabilities: target.capabilities,
          commands: target.commands,
        },
        formatTarget(target),
      );
      return;
    }

    case "list-features": {
      const list = features.list();
      write(
        json,
        list.map((feature) => ({
          name: feature.name,
          version: feature.version,
          description: feature.description,
          dependsOn: feature.dependsOn,
          conflictsWith: feature.conflictsWith,
          supportedTargets: feature.supportedTargets,
        })),
        formatFeatures(list),
      );
      return;
    }

    case "describe-feature": {
      const name = args.positional[0];
      if (name === undefined) throw new CliError("describe-feature requires a feature name");

      const feature = features.get(name);
      if (feature === undefined) {
        throw new CliError(`Unknown feature '${name}'. Available: ${features.names().join(", ")}`);
      }

      write(
        json,
        {
          name: feature.name,
          version: feature.version,
          description: feature.description,
          summary: feature.agentSummary,
          dependsOn: feature.dependsOn,
          conflictsWith: feature.conflictsWith,
          supportedTargets: feature.supportedTargets,
          configSchema: feature.configSchema,
          examples: feature.examples,
        },
        formatFeature(feature),
      );
      return;
    }

    case "validate": {
      const file = args.positional[0];
      if (file === undefined) throw new CliError("validate requires a specification path");

      const { path, spec } = await loadAndValidate(file);
      const compiled = compileBackend(spec, { features, targets });

      if (!compiled.ok) {
        throw new CliError("Specification is invalid", compiled.issues);
      }

      write(
        json,
        {
          valid: true,
          path,
          specVersion: spec.specVersion,
          entities: compiled.value.ir.entities.length,
          features: compiled.value.ir.features.map((feature) => feature.name),
          endpoints: compiled.value.ir.endpoints.length,
        },
        `Valid ${spec.specVersion} specification: ${path}\n` +
          `${compiled.value.ir.entities.length} entities, ${compiled.value.ir.features.length} features, ${compiled.value.ir.endpoints.length} endpoints`,
      );
      return;
    }

    case "inspect": {
      const file = args.positional[0];
      if (file === undefined) throw new CliError("inspect requires a specification path");

      const { spec } = await loadAndValidate(file);
      const compiled = compileBackend(spec, { features, targets });

      if (!compiled.ok) {
        throw new CliError("Specification is invalid", compiled.issues);
      }

      write(json, compiled.value.ir, formatSummary(compiled.value.ir));
      return;
    }

    case "generate":
    case "diff": {
      const file = args.positional[0];
      if (file === undefined) throw new CliError(`${args.command} requires a specification path`);

      const output = requireFlag(args, "output");
      const { spec } = await loadAndValidate(file);
      const dryRun = args.command === "diff" || args.flags.get("dry-run") === true;

      const acceptManual = args.flags.get("accept-manual");
      if (acceptManual === true) {
        throw new CliError(
          "--accept-manual requires a migration directory name, e.g. --accept-manual 20260717120000_backfill_owner",
        );
      }

      const outcome = await generateBackend({
        spec,
        outputDirectory: resolve(process.cwd(), output),
        features,
        targets,
        dryRun,
        force: args.flags.get("force") === true,
        allowDestructive: args.flags.get("allow-destructive") === true,
        ...(typeof acceptManual === "string" ? { acceptManualMigration: acceptManual } : {}),
      });

      if (!outcome.ok) {
        throw new CliError("Generation failed", outcome.issues);
      }

      write(json, outcome.report, formatReport(outcome.report));

      if (!outcome.report.success) {
        process.exitCode = 1;
      }
      return;
    }

    case "export-schema": {
      const name = args.positional[0];
      if (name === undefined || !(PUBLIC_SCHEMA_NAMES as string[]).includes(name)) {
        throw new CliError(
          `export-schema requires a schema name: ${PUBLIC_SCHEMA_NAMES.join(", ")}`,
        );
      }

      const schema = PUBLIC_SCHEMAS[name as PublicSchemaName];
      const contents = `${JSON.stringify(schema, null, 2)}\n`;
      const outputFlag = args.flags.get("output");

      if (outputFlag === undefined) {
        process.stdout.write(contents);
        return;
      }
      if (outputFlag === true) {
        throw new CliError("--output requires a file path, e.g. --output ./backend-spec.v1.schema.json");
      }

      const destination = resolve(process.cwd(), outputFlag);
      const exists = await access(destination)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        throw new CliError(`Refusing to overwrite existing file: ${destination}`);
      }

      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents, "utf8");
      write(
        json,
        { written: destination, schema: name, schemaId: schema.$id ?? null },
        `Wrote ${name} schema to ${destination}`,
      );
      return;
    }

    case "test-generated": {
      const output = requireFlag(args, "output");

      // The runner deliberately scrubs the environment; DATABASE_URL is the
      // one variable the generated project legitimately needs (Prisma refuses
      // to even validate its schema without it).
      const result = await runGeneratedTests({
        outputDirectory: resolve(process.cwd(), output),
        install: args.flags.get("install") === true,
        integration: args.flags.get("integration") === true,
        ...(process.env.DATABASE_URL
          ? { env: { DATABASE_URL: process.env.DATABASE_URL } }
          : {}),
      });

      const structured = {
        success: result.success,
        tests: result.tests,
        commands: result.commands.map((command) => ({
          command: command.command,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
        })),
      };

      const text = [
        result.success ? "Generated tests passed." : "Generated tests failed.",
        `Tests: ${result.tests.passed} passed, ${result.tests.failed} failed, ${result.tests.total} total`,
        "",
        ...result.commands.map(
          (command) => `${command.exitCode === 0 ? "ok  " : "fail"} ${command.command} (${command.durationMs}ms)`,
        ),
      ].join("\n");

      write(json, structured, text);

      if (!result.success) {
        if (!json) {
          const failed = result.commands.find((command) => command.exitCode !== 0);
          if (failed) {
            process.stderr.write(`\n${failed.output}\n`);
          }
        }
        process.exitCode = 1;
      }
      return;
    }

    default:
      throw new CliError(`Unknown command: ${args.command}\n\n${HELP}`);
  }
}

run().catch((error: unknown) => {
  const json = process.argv.includes("--json");

  if (error instanceof CliError || error instanceof CompilerError) {
    const issues = error instanceof CliError ? error.issues : error.issues;

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ success: false, error: error.message, issues }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`Error: ${error.message}\n`);
      if (issues.length > 0) {
        process.stderr.write(`${formatIssues(issues)}\n`);
      }
    }

    process.exitCode = 1;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
