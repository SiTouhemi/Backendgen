import { generateBackend, readManifest } from "@backend-compiler/generator-runtime";
import { scenarioSpec } from "@backend-compiler/testing";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CUSTOM_FILE = "src/custom/custom.module.ts";
const GENERATED_FILE = "src/generated/note/note.service.ts";

describe("safe regeneration", () => {
  let output: string;

  beforeEach(async () => {
    output = await mkdtemp(join(tmpdir(), "backendgen-regen-"));
  });

  afterEach(async () => {
    await rm(output, { recursive: true, force: true });
  });

  async function generate(options: { force?: boolean; dryRun?: boolean } = {}) {
    return generateBackend({
      spec: scenarioSpec("basic-crud"),
      outputDirectory: output,
      ...options,
    });
  }

  it("writes a manifest recording generator, feature versions and file hashes", async () => {
    const result = await generate();
    expect(result.ok).toBe(true);

    const manifest = await readManifest(output);

    expect(manifest).not.toBeNull();
    expect(manifest?.generator.name).toBe("backendgen");
    expect(manifest?.target.id).toBe("nestjs-prisma");
    expect(manifest?.features).toEqual([{ name: "crud", version: "0.2.0" }]);
    expect(manifest?.specChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest?.files.every((file) => file.hash.startsWith("sha256:"))).toBe(true);
  });

  it("preserves a custom file that the user has edited", async () => {
    await generate();

    const customPath = join(output, CUSTOM_FILE);
    const edited = "// my own module\nexport class CustomModule {}\n";
    await writeFile(customPath, edited, "utf8");

    const second = await generate();

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.report.preserved).toContain(CUSTOM_FILE);
    await expect(readFile(customPath, "utf8")).resolves.toBe(edited);
  });

  it("replaces an unchanged generated file without complaint", async () => {
    await generate();
    const second = await generate();

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.report.conflicts).toEqual([]);
    expect(second.report.changes.unchanged).toBeGreaterThan(0);
    expect(second.report.changes.update).toBe(0);
  });

  it("refuses to overwrite a generated file that was edited by hand", async () => {
    await generate();

    const generatedPath = join(output, GENERATED_FILE);
    const original = await readFile(generatedPath, "utf8");
    await writeFile(generatedPath, `${original}\n// a hand edit\n`, "utf8");

    const second = await generate();

    expect(second.ok).toBe(false);
    if (second.ok) return;

    expect(second.issues).toEqual([
      expect.objectContaining({
        code: "generate.modified-file",
        path: `/${GENERATED_FILE}`,
      }),
    ]);

    // The edit is still there: a refusal must not be destructive.
    await expect(readFile(generatedPath, "utf8")).resolves.toContain("// a hand edit");
  });

  it("reports the conflict in a dry run rather than failing", async () => {
    await generate();

    const generatedPath = join(output, GENERATED_FILE);
    await writeFile(generatedPath, "// replaced\n", "utf8");

    const preview = await generate({ dryRun: true });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.report.success).toBe(false);
    expect(preview.report.conflicts).toEqual([
      expect.objectContaining({ path: GENERATED_FILE, reason: "modified" }),
    ]);

    // A dry run writes nothing.
    await expect(readFile(generatedPath, "utf8")).resolves.toBe("// replaced\n");
  });

  it("overwrites a modified generated file only when forced, and warns", async () => {
    await generate();

    const generatedPath = join(output, GENERATED_FILE);
    await writeFile(generatedPath, "// replaced\n", "utf8");

    const forced = await generate({ force: true });

    expect(forced.ok).toBe(true);
    if (!forced.ok) return;

    expect(forced.report.warnings).toEqual([
      expect.stringContaining("Overwriting locally modified generated file"),
    ]);
    await expect(readFile(generatedPath, "utf8")).resolves.toContain("NoteService");
  });

  it("never overwrites a custom file, even when forced", async () => {
    await generate();

    const customPath = join(output, CUSTOM_FILE);
    await writeFile(customPath, "// mine\n", "utf8");

    const forced = await generate({ force: true });

    expect(forced.ok).toBe(true);
    await expect(readFile(customPath, "utf8")).resolves.toBe("// mine\n");
  });

  it("emits an incremental migration for a schema change instead of rewriting history", async () => {
    await generate();

    const spec = scenarioSpec("basic-crud");
    spec.entities.Note!.fields.priority = { type: "integer", minimum: 0 };

    const second = await generateBackend({ spec, outputDirectory: output });

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Added incremental migration")]),
    );
  });

  it("warns when the manifest exists but is corrupt", async () => {
    await generate();

    const manifestPath = join(output, ".backendgen/manifest.json");
    await writeFile(manifestPath, "{ not json", "utf8");

    const preview = await generate({ dryRun: true });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("not a valid generation manifest")]),
    );
  });

  it("fails clearly and without writing when a corrupt manifest destroys ownership", async () => {
    await generate();
    const generatedPath = join(output, GENERATED_FILE);
    const before = await readFile(generatedPath, "utf8");

    const manifestPath = join(output, ".backendgen/manifest.json");
    await writeFile(manifestPath, "{ not json", "utf8");

    const result = await generate({ force: true });

    expect(result).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "generate.invalid-manifest",
          path: "/.backendgen/manifest.json",
        }),
      ],
    });
    await expect(readFile(generatedPath, "utf8")).resolves.toBe(before);
  });

  it("removes a file that is no longer generated", async () => {
    await generateBackend({
      spec: scenarioSpec("basic-crud"),
      outputDirectory: output,
    });

    const stale = join(output, "src/generated/note/note.service.ts");
    await expect(readFile(stale, "utf8")).resolves.toContain("NoteService");

    // Regenerate from a specification that no longer declares Note. Dropping a
    // table is destructive, so it must be requested explicitly.
    const spec = scenarioSpec("basic-crud");
    spec.entities = {
      Task: { fields: { title: { type: "string", required: true } } },
    };

    const refused = await generateBackend({ spec, outputDirectory: output });
    expect(refused).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.destructive-change" })],
    });

    const second = await generateBackend({
      spec,
      outputDirectory: output,
      allowDestructive: true,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.report.deleted).toContain("src/generated/note/note.service.ts");
    await expect(readFile(stale, "utf8")).rejects.toThrow();
  });
});

describe("incremental migrations", () => {
  const INIT = "prisma/migrations/00000000000000_init/migration.sql";
  const FIRST = "prisma/migrations/00000000000001_backendgen/migration.sql";
  const SECOND = "prisma/migrations/00000000000002_backendgen/migration.sql";
  const SNAPSHOT = ".backendgen/schema-snapshot.json";

  let output: string;

  beforeEach(async () => {
    output = await mkdtemp(join(tmpdir(), "backendgen-incremental-"));
  });

  afterEach(async () => {
    await rm(output, { recursive: true, force: true });
  });

  function baseSpec() {
    return scenarioSpec("basic-crud");
  }

  async function generate(spec = baseSpec(), options: { allowDestructive?: boolean } = {}) {
    return generateBackend({ spec, outputDirectory: output, ...options });
  }

  it("records a versioned schema snapshot on the first generation", async () => {
    const result = await generate();
    expect(result.ok).toBe(true);

    const snapshot = JSON.parse(await readFile(join(output, SNAPSHOT), "utf8")) as {
      version: number;
      tables: Array<{ name: string }>;
    };
    expect(snapshot.version).toBe(1);
    expect(snapshot.tables.map((table) => table.name)).toContain("Note");
  });

  it("adds a nullable column incrementally and leaves the initial migration untouched", async () => {
    await generate();
    const initBefore = await readFile(join(output, INIT), "utf8");

    const spec = baseSpec();
    spec.entities.Note!.fields.priority = { type: "integer" };
    const second = await generate(spec);

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const migration = await readFile(join(output, FIRST), "utf8");
    expect(migration).toContain('ALTER TABLE "Note" ADD COLUMN "priority" INTEGER;');
    expect(migration).not.toContain("NOT NULL");

    await expect(readFile(join(output, INIT), "utf8")).resolves.toBe(initBefore);
    expect(second.report.created).toContain(FIRST);
  });

  it("backfills a required column through its specification default", async () => {
    await generate();

    const spec = baseSpec();
    spec.entities.Note!.fields.priority = { type: "integer", required: true, default: 3 };
    const second = await generate(spec);

    expect(second.ok).toBe(true);
    const migration = await readFile(join(output, FIRST), "utf8");
    expect(migration).toContain('ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 3;');
  });

  it("refuses a required column that has no default to backfill with", async () => {
    await generate();

    const spec = baseSpec();
    spec.entities.Note!.fields.priority = { type: "integer", required: true };

    await expect(generate(spec)).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.not-null-requires-default" })],
    });
  });

  it("refuses destructive changes unless explicitly allowed, then labels them", async () => {
    await generate();

    const spec = baseSpec();
    delete spec.entities.Note!.fields.pinned;

    await expect(generate(spec)).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "migrate.destructive-change" })],
    });

    const allowed = await generate(spec, { allowDestructive: true });
    expect(allowed.ok).toBe(true);

    const migration = await readFile(join(output, FIRST), "utf8");
    expect(migration).toContain("-- DESTRUCTIVE:");
    expect(migration).toContain('ALTER TABLE "Note" DROP COLUMN "pinned";');
  });

  it("creates a new table with its index and foreign key in one incremental migration", async () => {
    await generate();

    const spec = baseSpec();
    spec.entities.Attachment = {
      fields: { label: { type: "string", required: true } },
      relations: [{ name: "note", type: "belongsTo", target: "Note", required: true }],
    };
    const second = await generate(spec);

    expect(second.ok).toBe(true);
    const migration = await readFile(join(output, FIRST), "utf8");
    expect(migration).toContain('CREATE TABLE "Attachment"');
    expect(migration).toContain('CREATE INDEX "Attachment_noteId_idx"');
    expect(migration).toContain(
      'FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE RESTRICT',
    );
  });

  it("keeps enum value additions in a trailing non-transactional section", async () => {
    await generate();

    const withEnum = baseSpec();
    withEnum.entities.Note!.fields.status = {
      type: "string",
      required: true,
      enum: ["OPEN", "DONE"],
      default: "OPEN",
    };
    const second = await generate(withEnum);
    expect(second.ok).toBe(true);
    expect(await readFile(join(output, FIRST), "utf8")).toContain(
      'CREATE TYPE "NoteStatus" AS ENUM',
    );

    const widened = structuredClone(withEnum);
    widened.entities.Note!.fields.status = {
      type: "string",
      required: true,
      enum: ["OPEN", "DONE", "ARCHIVED"],
      default: "OPEN",
    };
    const third = await generate(widened);
    expect(third.ok).toBe(true);

    const migration = await readFile(join(output, SECOND), "utf8");
    expect(migration).toContain("cannot run inside a transaction block");
    expect(migration).toContain(`ALTER TYPE "NoteStatus" ADD VALUE 'ARCHIVED' AFTER 'DONE';`);
  });

  it("emits nothing when the specification is unchanged", async () => {
    await generate();
    const second = await generate();

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.report.changes.create).toBe(0);
    expect(second.report.changes.update).toBe(0);
    await expect(readFile(join(output, FIRST), "utf8")).rejects.toThrow();
  });

  it("emits byte-identical incremental migrations for identical changes", async () => {
    const other = await mkdtemp(join(tmpdir(), "backendgen-incremental-b-"));
    try {
      const spec = baseSpec();
      spec.entities.Note!.fields.priority = { type: "integer" };

      await generate();
      await generate(spec);

      await generateBackend({ spec: baseSpec(), outputDirectory: other });
      await generateBackend({ spec: structuredClone(spec), outputDirectory: other });

      const [left, right] = await Promise.all([
        readFile(join(output, FIRST), "utf8"),
        readFile(join(other, FIRST), "utf8"),
      ]);
      expect(left).toBe(right);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
