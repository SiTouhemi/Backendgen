import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Sandbox, SandboxError } from "./sandbox.js";

describe("Sandbox", () => {
  it("allows relative and absolute descendants, including new paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "backendgen-root-"));
    const sandbox = new Sandbox([root]);
    expect(sandbox.resolveInside("new/project")).toBe(resolve(root, "new/project"));
    expect(sandbox.resolveInside(join(root, "absolute"))).toBe(resolve(root, "absolute"));
  });

  it("rejects traversal, outside paths, and sibling-prefix tricks", async () => {
    const parent = await mkdtemp(join(tmpdir(), "backendgen-parent-"));
    const root = join(parent, "allowed");
    await mkdir(root);
    const sandbox = new Sandbox([root]);
    expect(() => sandbox.resolveInside("../outside")).toThrow(SandboxError);
    expect(() => sandbox.resolveInside(join(parent, "allowed-sibling"))).toThrow(SandboxError);
  });

  it("rejects symlink or junction escapes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "backendgen-links-"));
    const root = join(parent, "allowed");
    const outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    const link = join(root, "escape");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      // Some locked-down Windows environments disallow links; do not disguise
      // another failure as an unavailable platform capability.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() => new Sandbox([root]).resolveInside(join(link, "project"))).toThrow(SandboxError);
  });
});
