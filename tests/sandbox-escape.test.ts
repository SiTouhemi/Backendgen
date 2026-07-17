import { generateBackend } from "@backend-compiler/generator-runtime";
import { scenarioSpec } from "@backend-compiler/testing";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A junction or symlink inside the output directory must never redirect
 * generator writes outside the output root, even though every rendered path is
 * lexically relative and safe.
 */
describe("output sandbox: junction and symlink escapes", () => {
  let parent: string;
  let output: string;
  let outside: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "backendgen-escape-"));
    output = join(parent, "output");
    outside = join(parent, "outside");
    await mkdir(output);
    await mkdir(outside);
  });

  afterEach(async () => {
    // Remove any link first so recursive cleanup cannot traverse it.
    await rm(join(output, "src"), { force: true, recursive: false }).catch(() => {});
    await rm(join(output, "prisma"), { force: true, recursive: false }).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  });

  async function makeDirLink(linkPath: string, target: string): Promise<boolean> {
    try {
      await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
      return true;
    } catch (error) {
      // Some locked-down environments disallow links; skip rather than disguise
      // another failure as an unavailable platform capability.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      throw error;
    }
  }

  function generate(options: { force?: boolean } = {}) {
    return generateBackend({
      spec: scenarioSpec("basic-crud"),
      outputDirectory: output,
      ...options,
    });
  }

  it("refuses a first generation when a directory junction points outside the root", async () => {
    if (!(await makeDirLink(join(output, "src"), outside))) return;

    const result = await generate();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((entry) => entry.code === "generate.unsafe-output-path")).toBe(
      true,
    );

    // Nothing escaped through the junction.
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("refuses regeneration when a junction replaces a generated directory", async () => {
    const first = await generate();
    expect(first.ok).toBe(true);

    await rm(join(output, "src"), { recursive: true, force: true });
    if (!(await makeDirLink(join(output, "src"), outside))) return;

    const second = await generate({ force: true });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.issues.some((entry) => entry.code === "generate.unsafe-output-path")).toBe(
      true,
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("refuses to write through a file symlink at a generated path, even with --force", async () => {
    const first = await generate();
    expect(first.ok).toBe(true);

    const victim = join(outside, "victim.txt");
    await writeFile(victim, "untouched\n", "utf8");

    const generatedPath = join(output, "src", "generated", "note", "note.service.ts");
    await rm(generatedPath, { force: true });
    try {
      await symlink(victim, generatedPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const result = await generate({ force: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((entry) => entry.code === "generate.unsafe-output-path")).toBe(
      true,
    );
    await expect(readFile(victim, "utf8")).resolves.toBe("untouched\n");
  });
});
