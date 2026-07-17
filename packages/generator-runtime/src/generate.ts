import { issue, type Issue } from "@backend-compiler/common";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BackendIR } from "@backend-compiler/compiler";
import type { BackendSpec } from "@backend-compiler/specification";
import type { RenderedFile, SchemaChange, TargetAdapter } from "@backend-compiler/target-sdk";
import { compileBackend, type CompiledBackend } from "./compile.js";
import { changeSafety, describeChange, diffSchemas } from "./schema-diff.js";
import {
  createManifest,
  hashContents,
  MANIFEST_PATH,
  readManifestState,
  serializeManifest,
  type GenerationManifest,
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
  /**
   * Name of a hand-written, already-reviewed migration directory (for example
   * `20260717120000_backfill_owner`) that implements the entire pending schema
   * transition. When set, the generator validates that migration, records its
   * hash, advances the schema snapshot, and emits no automatic migration.
   */
  acceptManualMigration?: string;
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
  /** Migration files this run would create or replace, including reviewable SQL. */
  migrationSql: Array<{ path: string; sql: string; destructive: boolean }>;
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
export const ACCEPTED_MIGRATIONS_PATH = ".backendgen/accepted-migrations.json";

/** One accepted manual migration, bound to deterministic hash evidence. */
export interface AcceptedMigration {
  /** Migration directory name, e.g. `20260717120000_backfill_owner`. */
  migration: string;
  /** SHA-256 of the accepted migration.sql contents. */
  migrationHash: string;
  /** SHA-256 of the schema snapshot the transition started from. */
  previousSnapshotHash: string;
  /** SHA-256 of the schema snapshot the transition advanced to. */
  nextSnapshotHash: string;
  /** Human-readable descriptions of the schema changes the migration covers. */
  changes: string[];
}

interface AcceptedMigrationsRecord {
  version: 1;
  accepted: AcceptedMigration[];
}

function serializeAcceptedRecord(record: AcceptedMigrationsRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function parseAcceptedRecord(contents: string): AcceptedMigrationsRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as { version?: unknown; accepted?: unknown };
  if (record.version !== 1 || !Array.isArray(record.accepted)) return null;
  for (const entry of record.accepted) {
    if (typeof entry !== "object" || entry === null) return null;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.migration !== "string" ||
      typeof item.migrationHash !== "string" ||
      typeof item.previousSnapshotHash !== "string" ||
      typeof item.nextSnapshotHash !== "string" ||
      !Array.isArray(item.changes) ||
      !item.changes.every((change) => typeof change === "string")
    ) {
      return null;
    }
  }
  return record as AcceptedMigrationsRecord;
}

interface MigrationAdjustment {
  files: RenderedFile[];
  warnings: string[];
  issues: Issue[];
}

type TextRead =
  | { status: "present"; contents: string }
  | { status: "absent" }
  | { status: "error"; message: string };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readText(absolutePath: string): Promise<TextRead> {
  try {
    return { status: "present", contents: await readFile(absolutePath, "utf8") };
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "absent" }
      : { status: "error", message: errorMessage(error) };
  }
}

function migrationIssue(code: string, path: string, message: string): MigrationAdjustment {
  return { files: [], warnings: [], issues: [issue(code, `/${path}`, message)] };
}

function withSnapshot(files: readonly RenderedFile[], contents: string): RenderedFile[] {
  return [
    ...files.filter((file) => file.path !== SCHEMA_SNAPSHOT_PATH),
    { path: SCHEMA_SNAPSHOT_PATH, contents, ownership: "generated" as const },
  ];
}

/**
 * Turns the freshly rendered migration history into an incremental one when a
 * previous schema snapshot exists.
 *
 * With a trusted, manifest-bound snapshot: the on-disk initial migration and
 * every previously emitted incremental migration are frozen byte-for-byte, and
 * schema changes become one new `<counter>_backendgen` migration. Only a clean
 * first generation may start without a snapshot; existing history fails closed.
 */
async function applyIncrementalMigrations(input: {
  target: TargetAdapter;
  ir: BackendIR;
  migrationSql: readonly string[];
  files: readonly RenderedFile[];
  outputDirectory: string;
  allowDestructive: boolean;
  acceptManualMigration: string | null;
  manifest: GenerationManifest | null;
}): Promise<MigrationAdjustment> {
  const migrations = input.target.migrations;
  if (migrations === undefined) {
    return { files: [...input.files], warnings: [], issues: [] };
  }

  const nextSnapshot = migrations.buildSnapshot(input.ir, input.migrationSql);
  const serializedSnapshot = migrations.serializeSnapshot(nextSnapshot);
  const snapshotAbsolute = join(
    input.outputDirectory,
    SCHEMA_SNAPSHOT_PATH.split("/").join(sep),
  );
  const initPath = `${migrations.initialMigrationDirectory}/migration.sql`;
  const initAbsolute = join(input.outputDirectory, initPath.split("/").join(sep));
  const migrationsRootAbsolute = join(
    input.outputDirectory,
    migrations.migrationsRoot.split("/").join(sep),
  );
  const [snapshotRead, initRead] = await Promise.all([
    readText(snapshotAbsolute),
    readText(initAbsolute),
  ]);

  let entries: Dirent[] | null = null;
  let entriesError: unknown;
  try {
    entries = await readdir(migrationsRootAbsolute, { withFileTypes: true });
  } catch (error) {
    entriesError = error;
  }

  if (snapshotRead.status === "error") {
    return migrationIssue(
      "migrate.snapshot-unreadable",
      SCHEMA_SNAPSHOT_PATH,
      `The schema snapshot could not be read safely: ${snapshotRead.message}`,
    );
  }

  if (input.acceptManualMigration !== null && snapshotRead.status === "absent") {
    return migrationIssue(
      "migrate.accept-no-snapshot",
      SCHEMA_SNAPSHOT_PATH,
      "--accept-manual only applies to an existing generated project with a schema snapshot. A first generation has no pending transition to accept.",
    );
  }

  if (snapshotRead.status === "absent") {
    const hasHistory =
      input.manifest !== null ||
      initRead.status !== "absent" ||
      (entries !== null && entries.some((entry) => entry.isDirectory()));
    if (hasHistory) {
      return migrationIssue(
        "migrate.snapshot-missing",
        SCHEMA_SNAPSHOT_PATH,
        "An existing generated project has no schema snapshot. Refusing to rewrite migration history; restore the snapshot or regenerate into a clean directory.",
      );
    }
    if (entriesError !== undefined && errorCode(entriesError) !== "ENOENT") {
      return migrationIssue(
        "migrate.history-unreadable",
        migrations.migrationsRoot,
        `The migrations directory could not be inspected safely: ${errorMessage(entriesError)}`,
      );
    }
    return {
      files: withSnapshot(input.files, serializedSnapshot),
      warnings: [],
      issues: [],
    };
  }

  const previous = migrations.parseSnapshot(snapshotRead.contents);
  if (previous === null) {
    return migrationIssue(
      "migrate.snapshot-invalid",
      SCHEMA_SNAPSHOT_PATH,
      "The schema snapshot is corrupt or uses an unsupported version. Refusing to rewrite migration history; restore it from version control or regenerate into a clean directory.",
    );
  }

  if (input.manifest === null) {
    return migrationIssue(
      "migrate.snapshot-untracked",
      SCHEMA_SNAPSHOT_PATH,
      "A schema snapshot exists without a valid generation manifest, so its ownership and integrity cannot be verified.",
    );
  }

  const tracked = new Map(input.manifest.files.map((entry) => [entry.path, entry] as const));
  const snapshotEntry = tracked.get(SCHEMA_SNAPSHOT_PATH);
  if (snapshotEntry === undefined) {
    return migrationIssue(
      "migrate.snapshot-untracked",
      SCHEMA_SNAPSHOT_PATH,
      "The schema snapshot is not integrity-bound to the generation manifest. Regenerate into a clean directory before creating incremental migrations.",
    );
  }
  if (snapshotEntry.hash !== hashContents(snapshotRead.contents)) {
    return migrationIssue(
      "migrate.snapshot-modified",
      SCHEMA_SNAPSHOT_PATH,
      "The schema snapshot changed after generation. Refusing to derive a migration from untrusted state, even with --force.",
    );
  }

  if (initRead.status !== "present") {
    return migrationIssue(
      initRead.status === "error" ? "migrate.history-unreadable" : "migrate.history-missing",
      initPath,
      initRead.status === "error"
        ? `The initial migration could not be read safely: ${initRead.message}`
        : "The initial migration is missing. Generated migration history is immutable and cannot be recreated in place.",
    );
  }
  const initEntry = tracked.get(initPath);
  if (initEntry === undefined || initEntry.hash !== hashContents(initRead.contents)) {
    return migrationIssue(
      "migrate.history-modified",
      initPath,
      "The initial migration is untracked or differs from the manifest. Refusing to rewrite migration history, even with --force.",
    );
  }

  if (entries === null) {
    return migrationIssue(
      errorCode(entriesError) === "ENOENT" ? "migrate.history-missing" : "migrate.history-unreadable",
      migrations.migrationsRoot,
      errorCode(entriesError) === "ENOENT"
        ? "The migrations directory is missing even though a schema snapshot exists."
        : `The migrations directory could not be inspected safely: ${errorMessage(entriesError)}`,
    );
  }

  // History is immutable from here on: keep generator-owned migrations byte
  // for byte, validate every timestamped migration directory, and use the
  // highest prefix (including hand-written migrations) for the next number.
  const files = input.files.map((file) =>
    file.path === initPath ? { ...file, contents: initRead.contents } : file,
  );
  const escapedTag = migrations.incrementalTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const incrementalPattern = new RegExp(`^\\d{14}_${escapedTag}$`);
  const timestampPattern = /^(\d{14})_.+$/;
  const timestampedFolders = entries
    .filter((entry) => entry.isDirectory() && timestampPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const existingTrackedPaths = new Set<string>();
  const untrackedManualSql = new Map<string, string>();
  let highestPrefix = 0;
  let highestTrackedPrefix = 0;

  for (const folder of timestampedFolders) {
    const match = timestampPattern.exec(folder);
    const prefixNumber = Number(match?.[1] ?? 0);
    highestPrefix = Math.max(highestPrefix, prefixNumber);
    const path = `${migrations.migrationsRoot}/${folder}/migration.sql`;
    if (path === initPath) continue; // read, verified, and carried forward above
    const current = await readText(join(input.outputDirectory, path.split("/").join(sep)));
    if (current.status !== "present") {
      return migrationIssue(
        current.status === "error" ? "migrate.history-unreadable" : "migrate.history-missing",
        path,
        current.status === "error"
          ? `Migration history could not be read safely: ${current.message}`
          : `Migration directory ${folder} has no migration.sql file.`,
      );
    }

    const entry = tracked.get(path);
    if (incrementalPattern.test(folder)) {
      if (entry === undefined || entry.hash !== hashContents(current.contents)) {
        return migrationIssue(
          "migrate.history-modified",
          path,
          "A generated incremental migration is untracked or differs from the manifest. Migration history cannot be changed, even with --force.",
        );
      }
      existingTrackedPaths.add(path);
      highestTrackedPrefix = Math.max(highestTrackedPrefix, prefixNumber);
      files.push({ path, contents: current.contents, ownership: "generated" });
      continue;
    }

    if (entry !== undefined) {
      // A previously accepted manual migration: applied history is immutable.
      if (entry.hash !== hashContents(current.contents)) {
        return migrationIssue(
          "migrate.history-modified",
          path,
          "An accepted manual migration differs from the hash recorded at acceptance. Migration history cannot be changed, even with --force. Restore the file from version control.",
        );
      }
      existingTrackedPaths.add(path);
      highestTrackedPrefix = Math.max(highestTrackedPrefix, prefixNumber);
      files.push({ path, contents: current.contents, ownership: "generated" });
      continue;
    }

    untrackedManualSql.set(folder, current.contents);
  }

  const trackedMigrationPaths = input.manifest.files
    .map((entry) => entry.path)
    .filter((path) => {
      const prefix = `${migrations.migrationsRoot}/`;
      if (!path.startsWith(prefix) || !path.endsWith("/migration.sql")) return false;
      const folder = path.slice(prefix.length, -"/migration.sql".length);
      return path !== initPath && timestampPattern.test(folder);
    });
  const missingTracked = trackedMigrationPaths.find(
    (path) => !existingTrackedPaths.has(path),
  );
  if (missingTracked !== undefined) {
    return migrationIssue(
      "migrate.history-missing",
      missingTracked,
      "A migration recorded by the manifest is missing from disk. Restore it from version control.",
    );
  }

  // Carry the accepted-migrations record forward. It is generator-owned hash
  // evidence: if it exists it must be tracked, unmodified, and parseable.
  const acceptedAbsolute = join(
    input.outputDirectory,
    ACCEPTED_MIGRATIONS_PATH.split("/").join(sep),
  );
  const acceptedRead = await readText(acceptedAbsolute);
  const acceptedEntry = tracked.get(ACCEPTED_MIGRATIONS_PATH);
  if (acceptedRead.status === "error") {
    return migrationIssue(
      "migrate.accepted-record-unreadable",
      ACCEPTED_MIGRATIONS_PATH,
      `The accepted-migrations record could not be read safely: ${acceptedRead.message}`,
    );
  }
  if (acceptedRead.status === "absent" && acceptedEntry !== undefined) {
    return migrationIssue(
      "migrate.accepted-record-missing",
      ACCEPTED_MIGRATIONS_PATH,
      "The accepted-migrations record is tracked by the manifest but missing from disk. Restore it from version control.",
    );
  }
  let acceptedRecord: AcceptedMigrationsRecord = { version: 1, accepted: [] };
  if (acceptedRead.status === "present") {
    if (acceptedEntry === undefined || acceptedEntry.hash !== hashContents(acceptedRead.contents)) {
      return migrationIssue(
        "migrate.accepted-record-modified",
        ACCEPTED_MIGRATIONS_PATH,
        "The accepted-migrations record is untracked or was modified after generation. Refusing to trust it; restore it from version control.",
      );
    }
    const parsed = parseAcceptedRecord(acceptedRead.contents);
    if (parsed === null) {
      return migrationIssue(
        "migrate.accepted-record-invalid",
        ACCEPTED_MIGRATIONS_PATH,
        "The accepted-migrations record is corrupt or uses an unsupported version. Restore it from version control.",
      );
    }
    acceptedRecord = parsed;
    files.push({
      path: ACCEPTED_MIGRATIONS_PATH,
      contents: acceptedRead.contents,
      ownership: "generated",
    });
  }

  const changes = diffSchemas(previous, nextSnapshot);
  const acceptance = input.acceptManualMigration;

  if (changes.length === 0) {
    if (acceptance !== null) {
      return migrationIssue(
        "migrate.accept-no-changes",
        migrations.migrationsRoot,
        "Nothing to accept: the specification already matches the schema snapshot. Remove --accept-manual and regenerate.",
      );
    }
    return { files: withSnapshot(files, serializedSnapshot), warnings: [], issues: [] };
  }

  if (acceptance !== null) {
    return acceptManualTransition({
      acceptance,
      changes,
      files,
      untrackedManualSql,
      highestTrackedPrefix,
      acceptedRecord,
      previousSnapshotContents: snapshotRead.contents,
      serializedSnapshot,
      migrationsRoot: migrations.migrationsRoot,
      incrementalPattern,
      timestampPattern,
    });
  }

  const acceptHint =
    "Once a reviewed manual migration implements this transition, regenerate with " +
    "--accept-manual <migration-directory> to record it and advance the snapshot.";
  const issues: Issue[] = [];

  for (const change of changes) {
    if (change.kind === "add-column" && !change.column.nullable && change.column.default === null) {
      issues.push(
        issue(
          "migrate.not-null-requires-default",
          `/${change.table}/${change.column.name}`,
          `Adding required column "${change.table}"."${change.column.name}" needs a default to ` +
            "backfill existing rows. Give the field a default in the specification, or make it optional. " +
            acceptHint,
        ),
      );
    }
    if (change.kind === "alter-column-nullability" && !change.nullable) {
      issues.push(
        issue(
          "migrate.not-null-backfill-required",
          `/${change.table}/${change.column}`,
          `Making "${change.table}"."${change.column}" required needs an explicit data backfill before SET NOT NULL. ` +
            acceptHint,
        ),
      );
    }
    if (change.kind === "alter-column-type") {
      issues.push(
        issue(
          "migrate.type-change-unsupported",
          `/${change.table}/${change.column}`,
          `Changing "${change.table}"."${change.column}" from ${change.from} to ${change.to} ` +
            "cannot be cast safely without understanding the existing data and default expression. " +
            acceptHint,
        ),
      );
    }
    if (change.kind === "drop-feature-sql") {
      issues.push(
        issue(
          "migrate.feature-sql-change-unsupported",
          `/${migrations.migrationsRoot}`,
          "Feature-owned SQL was removed or replaced, but raw SQL has no safe automatic down migration. " +
            acceptHint,
        ),
      );
    }
    if (change.kind === "drop-enum") {
      issues.push(
        issue(
          "migrate.enum-change-unsupported",
          `/${change.enum}`,
          `Enum "${change.enum}" was removed, reordered, or changed anywhere except its tail. ` +
            acceptHint,
        ),
      );
    }
  }

  const hasEnumAddition = changes.some((change) => change.kind === "add-enum-value");
  if (hasEnumAddition && changes.some((change) => change.kind !== "add-enum-value")) {
    issues.push(
      issue(
        "migrate.mixed-enum-change-unsupported",
        `/${migrations.migrationsRoot}`,
        "Enum value additions must be deployed separately from column/default/constraint changes. Generate and apply the enum-only change first.",
      ),
    );
  }

  const destructive = changes.filter(
    (change) => change.kind !== "drop-enum" && changeSafety(change) === "destructive",
  );
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
    return { files, warnings: [], issues };
  }

  const nextPrefix = highestPrefix + 1;
  if (nextPrefix > 99_999_999_999_999) {
    return migrationIssue(
      "migrate.history-number-overflow",
      migrations.migrationsRoot,
      "Migration numbering exhausted the supported 14-digit prefix space.",
    );
  }
  const counter = String(nextPrefix).padStart(14, "0");
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

  return {
    files: withSnapshot(files, serializedSnapshot),
    warnings,
    issues: [],
  };
}

/**
 * The identifier a reviewed manual migration must visibly mention for a given
 * change. Table, column, and enum names appear literally in any SQL that
 * implements the change; index/constraint names and raw feature SQL are the
 * developer's choice, so they are not checked.
 */
function primaryIdentifier(change: SchemaChange): string | null {
  switch (change.kind) {
    case "create-table":
    case "drop-table":
      return change.table;
    case "add-column":
      return change.column.name;
    case "drop-column":
    case "alter-column-type":
    case "alter-column-nullability":
    case "alter-column-default":
      return change.column;
    case "create-enum":
      return change.enum.name;
    case "drop-enum":
      return change.enum;
    case "add-enum-value":
      return change.value;
    default:
      return null;
  }
}

/**
 * Records a reviewed, hand-written migration as implementing the entire pending
 * schema transition. Validation is strict: the directory must exist with a
 * non-empty migration.sql, must not be generator-owned or already recorded,
 * must sort after all recorded history, and must mention every table, column,
 * and enum the transition touches. Only then does the snapshot advance, with
 * the migration's hash bound into the manifest and the acceptance record.
 */
function acceptManualTransition(input: {
  acceptance: string;
  changes: SchemaChange[];
  files: RenderedFile[];
  untrackedManualSql: Map<string, string>;
  highestTrackedPrefix: number;
  acceptedRecord: AcceptedMigrationsRecord;
  previousSnapshotContents: string;
  serializedSnapshot: string;
  migrationsRoot: string;
  incrementalPattern: RegExp;
  timestampPattern: RegExp;
}): MigrationAdjustment {
  const { acceptance, changes, migrationsRoot } = input;
  const path = `${migrationsRoot}/${acceptance}/migration.sql`;

  if (!input.timestampPattern.test(acceptance)) {
    return migrationIssue(
      "migrate.accept-invalid-name",
      migrationsRoot,
      `--accept-manual expects a migration directory name like 20260717120000_backfill_owner; got '${acceptance}'.`,
    );
  }
  if (input.incrementalPattern.test(acceptance)) {
    return migrationIssue(
      "migrate.accept-owned-migration",
      path,
      "--accept-manual cannot name a generator-owned migration. Name the hand-written migration directory instead.",
    );
  }

  const sql = input.untrackedManualSql.get(acceptance);
  if (sql === undefined) {
    const alreadyRecorded = input.files.some((file) => file.path === path);
    return migrationIssue(
      alreadyRecorded ? "migrate.accept-already-recorded" : "migrate.accept-missing",
      path,
      alreadyRecorded
        ? `Migration ${acceptance} is already recorded in migration history and cannot be accepted twice.`
        : `Migration directory ${acceptance} was not found under ${migrationsRoot} (or has no migration.sql). ` +
          "Create the directory, write the reviewed SQL, apply it with the project's migrate command, then re-run.",
    );
  }
  if (sql.trim().length === 0) {
    return migrationIssue(
      "migrate.accept-empty",
      path,
      `Migration ${acceptance} has an empty migration.sql, so it cannot implement the pending schema transition.`,
    );
  }

  const prefixNumber = Number(/^(\d{14})_/.exec(acceptance)?.[1] ?? 0);
  if (prefixNumber <= input.highestTrackedPrefix) {
    return migrationIssue(
      "migrate.accept-out-of-order",
      path,
      `Migration ${acceptance} does not sort after the last recorded migration ` +
        `(${String(input.highestTrackedPrefix).padStart(14, "0")}), so it would not deploy after existing history. ` +
        "Recreate it with a later timestamp.",
    );
  }

  const descriptions = changes.map(describeChange);
  const missingIdentifiers = [
    ...new Set(
      changes
        .map(primaryIdentifier)
        .filter((name): name is string => name !== null && !sql.includes(name)),
    ),
  ];
  if (missingIdentifiers.length > 0) {
    return migrationIssue(
      "migrate.accept-incomplete",
      path,
      `Migration ${acceptance} never mentions: ${missingIdentifiers.join(", ")}. ` +
        `A manual migration must implement the entire pending transition: ${descriptions.join("; ")}.`,
    );
  }

  const files: RenderedFile[] = [
    ...input.files.filter((file) => file.path !== ACCEPTED_MIGRATIONS_PATH),
    { path, contents: sql, ownership: "generated" },
  ];
  const record: AcceptedMigrationsRecord = {
    version: 1,
    accepted: [
      ...input.acceptedRecord.accepted,
      {
        migration: acceptance,
        migrationHash: hashContents(sql),
        previousSnapshotHash: hashContents(input.previousSnapshotContents),
        nextSnapshotHash: hashContents(input.serializedSnapshot),
        changes: descriptions,
      },
    ],
  };
  files.push({
    path: ACCEPTED_MIGRATIONS_PATH,
    contents: serializeAcceptedRecord(record),
    ownership: "generated",
  });

  const preview = descriptions.slice(0, 6).join("; ");
  return {
    files: withSnapshot(files, input.serializedSnapshot),
    warnings: [
      `Accepted manual migration ${acceptance} as implementing ${changes.length} schema change(s): ` +
        `${preview}${changes.length > 6 ? "; …" : ""}. The schema snapshot advanced; this migration is now immutable history.`,
    ],
    issues: [],
  };
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
  const invalidManifestMessage =
    `${MANIFEST_PATH} exists but is not a valid generation manifest. ` +
    "Generation cannot safely determine file ownership. Regenerate into a clean directory " +
    "or restore the manifest from version control.";

  if (manifestState.status === "invalid" && !dryRun) {
    return {
      ok: false,
      issues: [issue("generate.invalid-manifest", `/${MANIFEST_PATH}`, invalidManifestMessage)],
    };
  }

  const adjustment: MigrationAdjustment =
    manifestState.status === "invalid"
      ? {
          files: [...rendered.files],
          warnings: [invalidManifestMessage],
          issues: [],
        }
      : await applyIncrementalMigrations({
          target: compiled.value.target,
          ir: compiled.value.ir,
          migrationSql: rendered.migrationSql,
          files: rendered.files,
          outputDirectory,
          allowDestructive: options.allowDestructive ?? false,
          acceptManualMigration: options.acceptManualMigration ?? null,
          manifest,
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

  const report = buildReport({
    compiled: compiled.value,
    plan,
    files,
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

  return { ok: true, report };
}

function buildReport(input: {
  compiled: CompiledBackend;
  plan: GenerationPlan;
  files: readonly RenderedFile[];
  outputDirectory: string;
  dryRun: boolean;
  fileCount: number;
}): GenerationReport {
  const { compiled, plan, files, outputDirectory, dryRun, fileCount } = input;
  const commands = compiled.target.commands;
  const migrationActions = new Set(
    plan.files
      .filter(
        (file) =>
          (file.action === "create" || file.action === "update") &&
          file.path.startsWith("prisma/migrations/") &&
          file.path.endsWith("/migration.sql"),
      )
      .map((file) => file.path),
  );
  const migrationSql = files
    .filter((file) => migrationActions.has(file.path))
    .map((file) => ({
      path: file.path,
      sql: file.contents,
      destructive: file.contents.includes("-- DESTRUCTIVE:"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

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
    migrationSql,
  };
}

/** A dry run by another name: what would change, and why it might refuse. */
export async function diffBackend(
  options: Omit<GenerateOptions, "dryRun">,
): Promise<GenerateOutcome> {
  return generateBackend({ ...options, dryRun: true });
}
