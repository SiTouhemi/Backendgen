import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "apps/cli/dist/src/index.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "backendgen-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

describe("backendgen subprocess contract", () => {
  it("reports the public generator version", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.2.1");
    expect(result.stderr).toBe("");
  });

  it("returns structured JSON and zero for a valid specification", () => {
    const result = run(["validate", "examples/hotel-booking/backend.yaml", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, specVersion: "backendcompiler.dev/v1" });
    expect(result.stderr).toBe("");
  });

  it("returns structured JSON and non-zero for an invalid command", () => {
    const result = run(["not-a-command", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false });
  });

  it("accepts an absolute output path through the actual bin entry", () => {
    const output = resolve(root, ".tmp-cli-dry-run");
    const result = run([
      "generate", "examples/hotel-booking/backend.yaml", "--output", output, "--dry-run", "--json",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, outputPath: output });
  });

  it("includes reviewable migration SQL in diff JSON and human output", async () => {
    const output = await temporaryDirectory();
    const args = ["diff", "examples/notes-api/backend.yaml", "--output", output];

    const jsonResult = run([...args, "--json"]);
    expect(jsonResult.status).toBe(0);
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      dryRun: true,
      migrationSql: [
        {
          path: "prisma/migrations/00000000000000_init/migration.sql",
          destructive: false,
          sql: expect.stringContaining("BEGIN;"),
        },
      ],
    });

    const humanResult = run(args);
    expect(humanResult.status).toBe(0);
    expect(humanResult.stdout).toContain("Migration SQL:");
    expect(humanResult.stdout).toContain("00000000000000_init/migration.sql");
    expect(humanResult.stdout).toContain("BEGIN;");
  });

  it("initializes a valid nested starter specification and refuses to overwrite it", async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, "nested", "backend.yaml");

    const initialized = run(["init", output, "--name", "local-demo", "--json"]);
    expect(initialized.status).toBe(0);
    expect(JSON.parse(initialized.stdout)).toEqual({ created: output });
    await expect(readFile(output, "utf8")).resolves.toContain("name: local-demo");

    const validated = run(["validate", output, "--json"]);
    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ valid: true });

    const overwrite = run(["init", output, "--name", "local-demo", "--json"]);
    expect(overwrite.status).toBe(1);
    expect(JSON.parse(overwrite.stdout)).toMatchObject({
      success: false,
      error: expect.stringContaining("Refusing to overwrite"),
    });
  });

  it("adds a YAML extension when init receives an extensionless path", async () => {
    const directory = await temporaryDirectory();
    const requested = join(directory, "demo");
    const output = `${requested}.yaml`;

    const initialized = run(["init", requested, "--name", "local-demo"]);
    expect(initialized.status).toBe(0);
    expect(initialized.stdout).toContain(`backendgen validate ${output}`);
    await expect(readFile(output, "utf8")).resolves.toContain("name: local-demo");

    const validated = run(["validate", output, "--json"]);
    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ valid: true });
  });

  it("exports both public schemas, refuses unknown names, and never overwrites", async () => {
    const directory = await temporaryDirectory();

    const toStdout = run(["export-schema", "spec"]);
    expect(toStdout.status).toBe(0);
    expect(JSON.parse(toStdout.stdout)).toMatchObject({
      $id: "https://backendcompiler.dev/schema/backend-spec.v1.schema.json",
    });

    const specOut = join(directory, "backend-spec.v1.schema.json");
    const wrote = run(["export-schema", "spec", "--output", specOut, "--json"]);
    expect(wrote.status).toBe(0);
    expect(JSON.parse(wrote.stdout)).toEqual({
      written: specOut,
      schema: "spec",
      schemaId: "https://backendcompiler.dev/schema/backend-spec.v1.schema.json",
    });
    expect(JSON.parse(await readFile(specOut, "utf8"))).toMatchObject({
      title: "Backend Compiler Specification v1",
    });

    const frontendOut = join(directory, "frontend-contract.v1.schema.json");
    const frontend = run(["export-schema", "frontend", "--output", frontendOut, "--json"]);
    expect(frontend.status).toBe(0);
    expect(JSON.parse(await readFile(frontendOut, "utf8"))).toMatchObject({
      $id: "https://backendcompiler.dev/schema/frontend-contract.v1.schema.json",
      properties: expect.objectContaining({
        schemaVersion: { const: "backendcompiler.dev/frontend-contract/v1" },
      }),
    });

    const overwrite = run(["export-schema", "spec", "--output", specOut, "--json"]);
    expect(overwrite.status).toBe(1);
    expect(JSON.parse(overwrite.stdout)).toMatchObject({
      success: false,
      error: expect.stringContaining("Refusing to overwrite"),
    });

    const unknown = run(["export-schema", "everything", "--json"]);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      success: false,
      error: expect.stringContaining("frontend, spec"),
    });
  });

  it("rejects an invalid init project name without creating a file", async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, "backend.yaml");

    const result = run(["init", output, "--name", "Invalid Name", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      error: "Invalid project name 'Invalid Name'",
      issues: [expect.objectContaining({ code: "schema.pattern", path: "/project/name" })],
    });
    await expect(access(output)).rejects.toThrow();
  });
});
