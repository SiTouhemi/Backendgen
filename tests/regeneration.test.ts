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

  it("removes a file that is no longer generated", async () => {
    await generateBackend({
      spec: scenarioSpec("basic-crud"),
      outputDirectory: output,
    });

    const stale = join(output, "src/generated/note/note.service.ts");
    await expect(readFile(stale, "utf8")).resolves.toContain("NoteService");

    // Regenerate from a specification that no longer declares Note.
    const spec = scenarioSpec("basic-crud");
    spec.entities = {
      Task: { fields: { title: { type: "string", required: true } } },
    };

    const second = await generateBackend({ spec, outputDirectory: output });

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.report.deleted).toContain("src/generated/note/note.service.ts");
    await expect(readFile(stale, "utf8")).rejects.toThrow();
  });
});
