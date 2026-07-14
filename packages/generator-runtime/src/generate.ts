import { issue, type Issue } from "@backend-compiler/common";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BackendSpec } from "@backend-compiler/specification";
import type { RenderedFile } from "@backend-compiler/target-sdk";
import { compileBackend, type CompiledBackend } from "./compile.js";
import {
  createManifest,
  hashContents,
  MANIFEST_PATH,
  readManifestState,
  serializeManifest,
  type ManifestFile,
} from "./manifest.js";
import {
  assertSafeRelativePath,
  planGeneration,
  summarizePlan,
  type FileAction,
  type FileConflict,
  type GenerationPlan,
} from "./plan.js";
import { createDefaultRegistry, createDefaultTargets, type TargetRegistry } from "./registries.js";
import { renderBackend } from "./render.js";
import type { FeatureRegistry } from "@backend-compiler/feature-sdk";

export interface GenerateOptions {
  spec: BackendSpec;
  outputDirectory: string;
  features?: FeatureRegistry;
  targets?: TargetRegistry;
  /** Plan and report, but write nothing. */
  dryRun?: boolean;
  /** Overwrite generated files that have been edited. Never touches `src/custom/`. */
  force?: boolean;
}

export interface GenerationReport {
  success: boolean;
  outputPath: string;
  dryRun: boolean;
  generatedFiles: number;
  changes: Record<FileAction, number>;
  created: string[];
  updated: string[];
  deleted: string[];
  preserved: string[];
  conflicts: FileConflict[];
  warnings: string[];
  customizationPoints: string[];
  target: { id: string; version: string };
  features: Array<{ name: string; version: string }>;
  endpoints: number;
  entities: number;
  specChecksum: string;
  irChecksum: string;
  /** Commands to run inside the generated project. */
  nextSteps: string[];
}

export type GenerateOutcome =
  | { ok: true; report: GenerationReport }
  | { ok: false; issues: Issue[] };

function byAction(plan: GenerationPlan, action: FileAction): string[] {
  return plan.files.filter((file) => file.action === action).map((file) => file.path);
}

async function writePlan(
  outputDirectory: string,
  plan: GenerationPlan,
  files: readonly RenderedFile[],
): Promise<void> {
  const contents = new Map(files.map((file) => [file.path, file.contents] as const));

  for (const file of plan.files) {
    const absolute = join(outputDirectory, file.path.split("/").join(sep));

    if (file.action === "delete") {
      await rm(absolute, { force: true });
      continue;
    }

    if (file.action === "unchanged" || file.action === "preserve") {
      continue;
    }

    const body = contents.get(file.path);
    if (body === undefined) continue;

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body, "utf8");
  }
}

/**
 * Compiles, renders, plans and (unless this is a dry run) writes.
 *
 * The manifest is written last, so an interrupted run leaves a manifest that
 * under-claims rather than over-claims what is on disk; the next run then treats
 * the extra files as untracked and refuses to clobber them silently.
 */
export async function generateBackend(options: GenerateOptions): Promise<GenerateOutcome> {
  const features = options.features ?? createDefaultRegistry();
  const targets = options.targets ?? createDefaultTargets();

  const compiled = compileBackend(options.spec, { features, targets });

  if (!compiled.ok) {
    return { ok: false, issues: compiled.issues };
  }

  const outputDirectory = resolve(options.outputDirectory);
  const rendered = renderBackend(compiled.value);

  const pathIssues = rendered.files
    .map((file) => assertSafeRelativePath(file.path))
    .filter((item): item is Issue => item !== null);

  if (pathIssues.length > 0) {
    return { ok: false, issues: pathIssues };
  }

  const manifestState = await readManifestState(outputDirectory);
  const manifest = manifestState.status === "present" ? manifestState.manifest : null;
  const force = options.force ?? false;
  const dryRun = options.dryRun ?? false;

  const plan = await planGeneration({
    outputDirectory,
    files: rendered.files,
    manifest,
    force,
  });

  if (manifestState.status === "invalid") {
    const message =
      `${MANIFEST_PATH} exists but is not a valid generation manifest. ` +
      "Generation cannot safely determine file ownership. Regenerate into a clean directory " +
      "or restore the manifest from version control.";
    plan.warnings.unshift(message);

    // A corrupt manifest destroys the ownership boundary. Refuse even with
    // --force: otherwise user-edited files at generated paths could be lost.
    if (!dryRun) {
      return {
        ok: false,
        issues: [issue("generate.invalid-manifest", `/${MANIFEST_PATH}`, message)],
      };
    }
  }

  const report = buildReport({
    compiled: compiled.value,
    plan,
    outputDirectory,
    dryRun,
    fileCount: rendered.files.length,
  });

  // A dry run always reports, including the conflicts that would have stopped a
  // real run. Only a real run refuses.
  if (dryRun) {
    return { ok: true, report };
  }

  if (plan.conflicts.length > 0) {
    return {
      ok: false,
      issues: plan.conflicts.map((conflict) =>
        issue(
          conflict.reason === "modified"
            ? "generate.modified-file"
            : "generate.untracked-file",
          `/${conflict.path}`,
          conflict.message,
        ),
      ),
    };
  }

  await mkdir(outputDirectory, { recursive: true });
  await writePlan(outputDirectory, plan, rendered.files);

  const manifestFiles: ManifestFile[] = rendered.files.map((file) => ({
    path: file.path,
    hash: hashContents(file.contents),
    ownership: file.ownership,
  }));

  const next = createManifest({
    target: { id: compiled.value.target.id, version: compiled.value.target.version },
    features: compiled.value.features.map((feature) => ({
      name: feature.pack.name,
      version: feature.pack.version,
    })),
    specChecksum: compiled.value.specChecksum,
    irChecksum: compiled.value.irChecksum,
    files: manifestFiles,
  });

  const manifestAbsolute = join(outputDirectory, MANIFEST_PATH.split("/").join(sep));
  await mkdir(dirname(manifestAbsolute), { recursive: true });
  await writeFile(manifestAbsolute, serializeManifest(next), "utf8");

  return { ok: true, report };
}

function buildReport(input: {
  compiled: CompiledBackend;
  plan: GenerationPlan;
  outputDirectory: string;
  dryRun: boolean;
  fileCount: number;
}): GenerationReport {
  const { compiled, plan, outputDirectory, dryRun, fileCount } = input;
  const commands = compiled.target.commands;

  return {
    success: plan.conflicts.length === 0,
    outputPath: outputDirectory,
    dryRun,
    generatedFiles: fileCount,
    changes: summarizePlan(plan),
    created: byAction(plan, "create"),
    updated: byAction(plan, "update"),
    deleted: byAction(plan, "delete"),
    preserved: byAction(plan, "preserve"),
    conflicts: plan.conflicts,
    warnings: plan.warnings,
    customizationPoints: compiled.ir.customizationPoints.map((point) => point.path),
    target: { id: compiled.target.id, version: compiled.target.version },
    features: compiled.features.map((feature) => ({
      name: feature.pack.name,
      version: feature.pack.version,
    })),
    endpoints: compiled.ir.endpoints.length,
    entities: compiled.ir.entities.length,
    specChecksum: compiled.specChecksum,
    irChecksum: compiled.irChecksum,
    nextSteps: [
      commands.install,
      "cp .env.example .env",
      "npm run db:generate",
      commands.migrate,
      commands.test,
    ],
  };
}

/** A dry run by another name: what would change, and why it might refuse. */
export async function diffBackend(
  options: Omit<GenerateOptions, "dryRun">,
): Promise<GenerateOutcome> {
  return generateBackend({ ...options, dryRun: true });
}
