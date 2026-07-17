import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnsafeOutputPaths } from "./safe-fs.js";

async function makeRoots(): Promise<{ root: string; outside: string }> {
  const parent = await mkdtemp(join(tmpdir(), "backendgen-safefs-"));
  const root = join(parent, "root");
  const outside = join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}

async function linkOrSkip(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

describe("findUnsafeOutputPaths", () => {
  it("accepts not-yet-created paths and real directories", async () => {
    const { root } = await makeRoots();
    await mkdir(join(root, "src"));

    const issues = await findUnsafeOutputPaths(root, [
      "src/app.module.ts",
      "deep/new/tree/file.ts",
    ]);

    expect(issues).toEqual([]);
  });

  it("flags a path whose directory component is a link", async () => {
    const { root, outside } = await makeRoots();
    if (!(await linkOrSkip(outside, join(root, "src")))) return;

    const issues = await findUnsafeOutputPaths(root, ["src/escape.ts"]);

    expect(issues).toEqual([
      expect.objectContaining({ code: "generate.unsafe-output-path", path: "/src/escape.ts" }),
    ]);
  });

  it("flags a link at the final component", async () => {
    const { root, outside } = await makeRoots();
    if (!(await linkOrSkip(outside, join(root, "escape")))) return;

    const issues = await findUnsafeOutputPaths(root, ["escape"]);

    expect(issues).toEqual([
      expect.objectContaining({ code: "generate.unsafe-output-path", path: "/escape" }),
    ]);
  });
});
