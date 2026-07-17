import {
  ACCEPTED_MIGRATIONS_PATH,
  generateBackend,
  readManifest,
  SCHEMA_SNAPSHOT_PATH,
} from "@backend-compiler/generator-runtime";
import { scenarioSpec } from "@backend-compiler/testing";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MANUAL_DIR = "20260717120000_backfill_pinned";
const MANUAL_PATH = `prisma/migrations/${MANUAL_DIR}/migration.sql`;
const MANUAL_SQL = [
  "-- Reviewed manual migration: backfill pinned, then tighten nullability.",
  'UPDATE "Note" SET "pinned" = false WHERE "pinned" IS NULL;',
  'ALTER TABLE "Note" ALTER COLUMN "pinned" SET NOT NULL;',
  "",
].join("\n");

describe("manual migration acceptance", () => {
  let output: string;

  beforeEach(async () => {
    output = await mkdtemp(join(tmpdir(), "backendgen-manual-"));
  });

  afterEach(async () => {
    await rm(output, { recursive: true, force: true });
  });

  function baseSpec() {
    return scenarioSpec("basic-crud");
  }

  /** basic-crud declares Note.pinned as an optional boolean; require it. */
  function tightenedSpec() {
    const spec = baseSpec();
    spec.entities.Note!.fields.pinned = { type: "boolean", required: true, default: false };
    return spec;
  }

  async function writeManualMigration(directory = MANUAL_DIR, sql = MANUAL_SQL) {
    const absolute = join(output, "prisma/migrations", directory);
    await mkdir(absolute, { recursive: true });
    await writeFile(join(absolute, "migration.sql"), sql, "utf8");
  }

  it("rejects the tightening transition and points to --accept-manual", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });

    const refused = await generateBackend({ spec: tightenedSpec(), outputDirectory: output });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.issues).toEqual([
      expect.objectContaining({
        code: "migrate.not-null-backfill-required",
        message: expect.stringContaining("--accept-manual"),
      }),
    ]);
  });

  it("accepts a reviewed backfill migration, advances the snapshot, and stays stable", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    const snapshotBefore = await readFile(join(output, SCHEMA_SNAPSHOT_PATH), "utf8");
    await writeManualMigration();

    const accepted = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });

    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining(`Accepted manual migration ${MANUAL_DIR}`)]),
    );

    // The snapshot advanced and no automatic migration was emitted.
    const snapshotAfter = await readFile(join(output, SCHEMA_SNAPSHOT_PATH), "utf8");
    expect(snapshotAfter).not.toBe(snapshotBefore);
    const manifest = await readManifest(output);
    const paths = manifest?.files.map((file) => file.path) ?? [];
    expect(paths).toContain(MANUAL_PATH);
    expect(paths).toContain(ACCEPTED_MIGRATIONS_PATH);
    expect(paths.filter((path) => path.includes("_backendgen/"))).toEqual([]);

    // Acceptance evidence binds hashes of migration and both snapshots.
    const record = JSON.parse(await readFile(join(output, ACCEPTED_MIGRATIONS_PATH), "utf8")) as {
      version: number;
      accepted: Array<Record<string, unknown>>;
    };
    expect(record.version).toBe(1);
    expect(record.accepted).toEqual([
      expect.objectContaining({
        migration: MANUAL_DIR,
        migrationHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        previousSnapshotHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        nextSnapshotHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        changes: [expect.stringContaining("pinned")],
      }),
    ]);

    // A follow-up generation with the same specification is a no-op.
    const third = await generateBackend({ spec: tightenedSpec(), outputDirectory: output });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.report.changes.create).toBe(0);
    expect(third.report.changes.update).toBe(0);
    await expect(readFile(join(output, MANUAL_PATH), "utf8")).resolves.toBe(MANUAL_SQL);
  });

  it("rejects acceptance when the named migration directory does not exist", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });

    const result = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accept-missing" })],
    });
  });

  it("rejects acceptance when the migration never mentions the changed column", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    await writeManualMigration(MANUAL_DIR, "-- does nothing relevant\nSELECT 1;\n");

    const result = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "migrate.accept-incomplete",
          message: expect.stringContaining("pinned"),
        }),
      ],
    });
  });

  it("rejects an empty migration, a generator-owned name, and a malformed name", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    await writeManualMigration(MANUAL_DIR, "\n\n");

    const empty = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });
    expect(empty).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accept-empty" })],
    });

    const owned = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: "20260717120000_backendgen",
    });
    expect(owned).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accept-owned-migration" })],
    });

    const malformed = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: "../escape",
    });
    expect(malformed).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accept-invalid-name" })],
    });
  });

  it("rejects acceptance when nothing changed, or on a first generation", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    await writeManualMigration();

    const noChanges = await generateBackend({
      spec: baseSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });
    expect(noChanges).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accept-no-changes" })],
    });

    const fresh = await mkdtemp(join(tmpdir(), "backendgen-manual-fresh-"));
    try {
      const first = await generateBackend({
        spec: baseSpec(),
        outputDirectory: fresh,
        acceptManualMigration: MANUAL_DIR,
      });
      expect(first).toMatchObject({
        ok: false,
        issues: [expect.objectContaining({ code: "migrate.accept-no-snapshot" })],
      });
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("rejects a manual migration that would not deploy after recorded history", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });

    // Record a generated incremental migration first.
    const withPriority = baseSpec();
    withPriority.entities.Note!.fields.priority = { type: "integer" };
    const second = await generateBackend({ spec: withPriority, outputDirectory: output });
    expect(second.ok).toBe(true);

    // 00000000000001_backendgen now exists; an older-stamped manual migration
    // would sort before it and never deploy in order.
    const stale = "00000000000000_backfill_pinned";
    await writeManualMigration(stale);
    const spec = structuredClone(withPriority);
    spec.entities.Note!.fields.pinned = { type: "boolean", required: true, default: false };

    const result = await generateBackend({
      spec,
      outputDirectory: output,
      acceptManualMigration: stale,
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accept-out-of-order" })],
    });
  });

  it("freezes an accepted migration: later edits or deletion fail closed", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    await writeManualMigration();
    const accepted = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });
    expect(accepted.ok).toBe(true);

    const absolute = join(output, MANUAL_PATH);
    await writeFile(absolute, `${MANUAL_SQL}-- sneaky edit\n`, "utf8");
    await expect(
      generateBackend({ spec: tightenedSpec(), outputDirectory: output, force: true }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "migrate.history-modified",
          path: `/${MANUAL_PATH}`,
        }),
      ],
    });

    await writeFile(absolute, MANUAL_SQL, "utf8");
    const restored = await generateBackend({ spec: tightenedSpec(), outputDirectory: output });
    expect(restored.ok).toBe(true);

    await rm(join(output, "prisma/migrations", MANUAL_DIR), { recursive: true });
    await expect(
      generateBackend({ spec: tightenedSpec(), outputDirectory: output }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.history-missing" })],
    });
  });

  it("rejects acceptance of a migration that is already recorded", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    await writeManualMigration();
    await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });

    // A further schema change must not be attributed to the same migration.
    const spec = tightenedSpec();
    spec.entities.Note!.fields.body = { type: "string", required: true };

    const result = await generateBackend({
      spec,
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accept-already-recorded" })],
    });
  });

  it("fails closed when the acceptance record is tampered with or deleted", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    await writeManualMigration();
    await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });

    const recordPath = join(output, ACCEPTED_MIGRATIONS_PATH);
    const original = await readFile(recordPath, "utf8");

    await writeFile(recordPath, original.replace("sha256:", "sha256:0"), "utf8");
    await expect(
      generateBackend({ spec: tightenedSpec(), outputDirectory: output }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accepted-record-modified" })],
    });

    await rm(recordPath);
    await expect(
      generateBackend({ spec: tightenedSpec(), outputDirectory: output }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.accepted-record-missing" })],
    });

    await writeFile(recordPath, original, "utf8");
    const restored = await generateBackend({ spec: tightenedSpec(), outputDirectory: output });
    expect(restored.ok).toBe(true);
  });

  it("still fails on an incomplete migration directory during acceptance", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    await mkdir(join(output, "prisma/migrations/20260717110000_halfway"), { recursive: true });
    await writeManualMigration();

    const result = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.history-missing" })],
    });
  });

  it("previews acceptance in a dry run without writing anything", async () => {
    await generateBackend({ spec: baseSpec(), outputDirectory: output });
    await writeManualMigration();
    const snapshotBefore = await readFile(join(output, SCHEMA_SNAPSHOT_PATH), "utf8");

    const preview = await generateBackend({
      spec: tightenedSpec(),
      outputDirectory: output,
      acceptManualMigration: MANUAL_DIR,
      dryRun: true,
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Accepted manual migration")]),
    );
    await expect(readFile(join(output, SCHEMA_SNAPSHOT_PATH), "utf8")).resolves.toBe(
      snapshotBefore,
    );
    await expect(readFile(join(output, ACCEPTED_MIGRATIONS_PATH), "utf8")).rejects.toThrow();
  });
});
