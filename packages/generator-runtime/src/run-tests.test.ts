import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createManifest, hashContents, MANIFEST_PATH, readManifest, serializeManifest } from "./manifest.js";
import { runGeneratedTests } from "./run-tests.js";

describe("generated test execution preflight", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function directory(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), "backendgen-tests-"));
    directories.push(value);
    return value;
  }

  it("refuses to execute an arbitrary package directory", async () => {
    const outputDirectory = await directory();
    await writeFile(
      join(outputDirectory, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"process.exit(99)\"" } }),
    );

    const result = await runGeneratedTests({ outputDirectory });

    expect(result.success).toBe(false);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.command).toBe("verify generated manifest");
  });

  it("refuses to execute a generated package whose scripts were modified", async () => {
    const outputDirectory = await directory();
    const original = JSON.stringify({ scripts: { test: "jest" } });
    await writeFile(join(outputDirectory, "package.json"), original);
    await mkdir(join(outputDirectory, ".backendgen"));
    const manifest = createManifest({
      target: { id: "nestjs-prisma", version: "0.2.0" },
      features: [],
      specChecksum: "sha256:spec",
      irChecksum: "sha256:ir",
      files: [{ path: "package.json", hash: hashContents(original), ownership: "generated" }],
    });
    await writeFile(join(outputDirectory, MANIFEST_PATH), serializeManifest(manifest));
    await writeFile(
      join(outputDirectory, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"process.exit(99)\"" } }),
    );

    const result = await runGeneratedTests({ outputDirectory });

    expect(result.success).toBe(false);
    expect(result.commands[0]?.output).toContain("modified after generation");
  });

  it("rejects malformed manifest structures", async () => {
    const outputDirectory = await directory();
    await mkdir(join(outputDirectory, ".backendgen"));
    await writeFile(
      join(outputDirectory, MANIFEST_PATH),
      JSON.stringify({ manifestVersion: 1, files: "not-an-array" }),
    );

    await expect(readManifest(outputDirectory)).resolves.toBeNull();
  });
});
