import { issue, type Issue } from "@backend-compiler/common";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BackendIR } from "@backend-compiler/compiler";
import type { BackendSpec } from "@backend-compiler/specification";
import type { RenderedFile, TargetAdapter } from "@backend-compiler/target-sdk";
import { compileBackend, type CompiledBackend } from "./compile.js";
import { changeSafety, describeChange, diffSchemas } from "./schema-diff.js";
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
  /**
   * Allow an incremental migration to contain data-losing statements
   * (DROP TABLE/COLUMN, type changes). Refused by default.
   */
  allowDestructive?: boolean;
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

export const SCHEMA_SNAPSHOT_PATH = ".backendgen/schema-snapshot.json";

interface MigrationAdjustment {
  files: RenderedFile[];
  warnings: string[];
  issues: Issue[];
  /** Serialized snapshot to record after a successful write, like the manifest. */
  snapshot: string | null;
}

async function readIfExists(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Turns the freshly rendered migration history into an incremental one when a
 * previous schema snapshot exists.
 *
 * With a snapshot: the on-disk initial migration and every previously emitted
 * incremental migration are frozen exactly as they are (history is immutable),
 * and schema changes become one new `<counter>_backendgen` migration. Without a
 * snapshot (legacy projects, first generation) the rewrite-in-place behaviour
 * is kept and a snapshot is recorded so the next run can diff.
 */
async function applyIncrementalMigrations(input: {
  target: TargetAdapter;
  ir: BackendIR;
  migrationSql: readonly string[];
  files: readonly RenderedFile[];
  outputDirectory: string;
  allowDestructive: boolean;
}): Promise<MigrationAdjustment> {
  const migrations = input.target.migrations;
  if (migrations === undefined) {
    return { files: [...input.files], warnings: [], issues: [], snapshot: null };
  }

  const nextSnapshot = migrations.buildSnapshot(input.ir, input.migrationSql);
  const serializedSnapshot = migrations.serializeSnapshot(nextSnapshot);

  const snapshotAbsolute = join(
    input.outputDirectory,
    SCHEMA_SNAPSHOT_PATH.split("/").join(sep),
  );
  const previousRaw = await readIfExists(snapshotAbsolute);
  const previous = previousRaw === null ? null : migrations.parseSnapshot(previousRaw);

  if (previous === null) {
    const warnings =
      previousRaw !== null
        ? [
            `${SCHEMA_SNAPSHOT_PATH} could not be parsed; falling back to rewriting the ` +
              "initial migration. The snapshot has been rewritten for future incremental runs.",
          ]
        : [];
    return { files: [...input.files], warnings, issues: [], snapshot: serializedSnapshot };
  }

  // History is immutable from here on: keep whatever is on disk, byte for byte.
  const initPath = `${migrations.initialMigrationDirectory}/migration.sql`;
  const onDiskInit = await readIfExists(join(input.outputDirectory, initPath.split("/").join(sep)));
  const files = input.files.map((file) =>
    file.path === initPath && onDiskInit !== null ? { ...file, contents: onDiskInit } : file,
  );

  const incrementalPattern = new RegExp(`^\\d{14}_${migrations.incrementalTag}$`);
  const migrationsRootAbsolute = join(
    input.outputDirectory,
    migrations.migrationsRoot.split("/").join(sep),
  );
  const entries = await readdir(migrationsRootAbsolute, { withFileTypes: true }).catch(
    () => [],
  );
  const existingFolders = entries
    .filter((entry) => entry.isDirectory() && incrementalPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const folder of existingFolders) {
    const path = `${migrations.migrationsRoot}/${folder}/migration.sql`;
    const contents = await readIfExists(join(input.outputDirectory, path.split("/").join(sep)));
    if (contents !== null) {
      files.push({ path, contents, ownership: "generated" });
    }
  }

  const changes = diffSchemas(previous, nextSnapshot);
  if (changes.length === 0) {
    return { files, warnings: [], issues: [], snapshot: serializedSnapshot };
  }

  const issues: Issue[] = [];

  for (const change of changes) {
    if (change.kind === "add-column" && !change.column.nullable && change.column.default === null) {
      issues.push(
        issue(
          "migrate.not-null-requires-default",
          `/${change.table}/${change.column.name}`,
          `Adding required column "${change.table}"."${change.column.name}" needs a default to ` +
            "backfill existing rows. Give the field a default in the specification, or make it optional.",
        ),
      );
    }
  }

  const destructive = changes.filter((change) => changeSafety(change) === "destructive");
  if (destructive.length > 0 && !input.allowDestructive) {
    issues.push(
      issue(
        "migrate.destructive-change",
        `/${migrations.migrationsRoot}`,
        "The specification change requires destructive statements: " +
          destructive.map(describeChange).join("; ") +
          ". Re-run with --allow-destructive to emit them, or adjust the specification.",
      ),
    );
  }

  if (issues.length > 0) {
    return { files, warnings: [], issues, snapshot: null };
  }

  // Prisma only requires lexicographic ordering of migration folders, so a
  // deterministic zero-padded counter replaces a wall-clock timestamp.
  const counter = String(existingFolders.length + 1).padStart(14, "0");
  const migrationPath = `${migrations.migrationsRoot}/${counter}_${migrations.incrementalTag}/migration.sql`;
  files.push({
    path: migrationPath,
    contents: migrations.renderDiffMigration(changes, {
      allowDestructive: input.allowDestructive,
    }),
    ownership: "generated",
  });

  const preview = changes.slice(0, 6).map(describeChange).join("; ");
  const warnings = [
    `Added incremental migration ${migrationPath} with ${changes.length} change(s): ` +
      `${preview}${changes.length > 6 ? "; …" : ""}. Apply it with the project's migrate command.`,
  ];

  return { files, warnings, issues: [], snapshot: serializedSnapshot };
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

  const adjustment = await applyIncrementalMigrations({
    target: compiled.value.target,
    ir: compiled.value.ir,
    migrationSql: rendered.migrationSql,
    files: rendered.files,
    outputDirectory,
    allowDestructive: options.allowDestructive ?? false,
  });

  if (adjustment.issues.length > 0) {
    return { ok: false, issues: adjustment.issues };
  }

  const files = adjustment.files;

  const plan = await planGeneration({
    outputDirectory,
    files,
    manifest,
    force,
  });
  plan.warnings.push(...adjustment.warnings);

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
    fileCount: files.length,
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
  await writePlan(outputDirectory, plan, files);

  const manifestFiles: ManifestFile[] = files.map((file) => ({
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

  // The schema snapshot is runtime bookkeeping, exactly like the manifest: it
  // lives beside it and is written last, after the files it describes.
  if (adjustment.snapshot !== null) {
    const snapshotAbsolute = join(outputDirectory, SCHEMA_SNAPSHOT_PATH.split("/").join(sep));
    await writeFile(snapshotAbsolute, adjustment.snapshot, "utf8");
  }

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
