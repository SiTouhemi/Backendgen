import {
  createDefaultRegistry,
  createDefaultTargets,
  generateBackend,
  readManifest,
  runGeneratedTests,
} from "@backend-compiler/generator-runtime";
import { SCENARIOS } from "@backend-compiler/testing";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const roots: string[] = [];
const selected = process.env.BACKENDGEN_E2E_SCENARIO
  ? SCENARIOS.filter((item) => item.name === process.env.BACKENDGEN_E2E_SCENARIO)
  : SCENARIOS;

if (selected.length === 0) throw new Error(`Unknown BACKENDGEN_E2E_SCENARIO '${process.env.BACKENDGEN_E2E_SCENARIO}'`);

async function verifyInitialMigrationRollback(output: string, root: string, databaseUrl: string) {
  const migrationPath = join(
    output,
    "prisma",
    "migrations",
    "00000000000000_init",
    "migration.sql",
  );
  const migration = await readFile(migrationPath, "utf8");
  expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;\s*$/);

  const failing = migration.replace(/COMMIT;\s*$/, "SELECT 1 / 0;\n\nCOMMIT;\n");
  const probePath = join(root, "initial-migration-rollback-probe.sql");
  await writeFile(probePath, failing, "utf8");

  const psqlUrl = new URL(databaseUrl);
  psqlUrl.searchParams.delete("schema");
  const failed = spawnSync(
    "psql",
    [psqlUrl.toString(), "-X", "-v", "ON_ERROR_STOP=1", "--file", probePath],
    { encoding: "utf8" },
  );
  expect(failed.status, `${failed.stdout}\n${failed.stderr}`).not.toBe(0);

  const tables = spawnSync(
    "psql",
    [
      psqlUrl.toString(),
      "-X",
      "-tA",
      "-c",
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';",
    ],
    { encoding: "utf8" },
  );
  expect(tables.status, `${tables.stdout}\n${tables.stderr}`).toBe(0);
  expect(tables.stdout.trim()).toBe("0");
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("generated project lifecycle", () => {
  it.each(selected)("generates, owns, regenerates, and optionally executes $name", async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), `backendgen-${scenario.name}-`));
    roots.push(root);
    const output = join(root, "project");
    const options = {
      spec: structuredClone(scenario.spec), outputDirectory: output,
      features: createDefaultRegistry(), targets: createDefaultTargets(),
    };
    const first = await generateBackend(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.report.generatedFiles).toBeGreaterThan(20);

    const manifest = await readManifest(output);
    expect(manifest).not.toBeNull();
    expect(manifest?.files.some((file) => file.path === "package.json")).toBe(true);
    const scaffold = manifest?.files.find((file) => file.ownership === "custom-scaffold");
    expect(scaffold).toBeDefined();
    const scaffoldPath = join(output, scaffold!.path);
    const customized = `${await readFile(scaffoldPath, "utf8")}\n// user customization\n`;
    await writeFile(scaffoldPath, customized, "utf8");
    const userFile = join(output, "src", "custom", "user-owned.ts");
    await writeFile(userFile, "export const userOwned = true;\n", "utf8");

    const second = await generateBackend(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.report.changes.create).toBe(0);
    expect(second.report.changes.update).toBe(0);
    expect(await readFile(scaffoldPath, "utf8")).toBe(customized);
    expect(await readFile(userFile, "utf8")).toContain("userOwned");

    if (process.env.BACKENDGEN_E2E_BUILD === "1") {
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl !== undefined) {
        await verifyInitialMigrationRollback(output, root, databaseUrl);
      }
      const result = await runGeneratedTests({
        outputDirectory: output,
        install: true,
        integration: Boolean(databaseUrl),
        env: {
          DATABASE_URL: databaseUrl ?? "postgresql://backendgen:backendgen@127.0.0.1:5432/backendgen",
        },
      });
      expect(result.success, result.commands.map((command) => command.output).join("\n")).toBe(true);
    }
  });
});
