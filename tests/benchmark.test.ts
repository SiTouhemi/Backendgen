import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const validateScript = resolve(root, "benchmark/validate-results.mjs");
const summarizeScript = resolve(root, "benchmark/summarize-results.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "backendgen-benchmark-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runScript(script: string, directory: string) {
  return spawnSync(process.execPath, [script, "--dir", directory], { cwd: root, encoding: "utf8" });
}

interface ResultOverrides {
  arm: "direct" | "compiler";
  pairId: string;
  runId: string;
  tokens?: { input: number | null; cached: number | null; output: number | null; tool: number | null };
  wallClockMs?: number;
  passed?: boolean;
  model?: string;
}

function result(overrides: ResultOverrides): Record<string, unknown> {
  const tokens = overrides.tokens ?? { input: 1000, cached: 100, output: 500, tool: 50 };
  const passed = overrides.passed ?? true;
  return {
    schemaVersion: "backendcompiler.dev/benchmark-result/v2",
    scenario: "todo-crud",
    arm: overrides.arm,
    model: overrides.model ?? "example-model-2026-01-01",
    agent: { name: "example-agent", version: "1.2.3" },
    pairId: overrides.pairId,
    pairPosition: "independent",
    runId: overrides.runId,
    protocol: {
      promptFile: "benchmark/prompts/todo-crud.md",
      requirementsFile: "benchmark/requirements/todo-crud.md",
      suppliedContext: "none",
      startingRepoState: "empty directory",
      maxAttempts: 3,
      environment: {
        machine: "test-runner",
        os: "test-os",
        nodeVersion: "22.17.1",
        dependencyCacheState: "empty",
        toolPermissions: "workspace-write",
      },
    },
    measurements: {
      attempts: 1,
      inputTokens: tokens.input,
      cachedInputTokens: tokens.cached,
      outputTokens: tokens.output,
      toolCallTokens: tokens.tool,
      wallClockMs: overrides.wallClockMs ?? 60_000,
      agentWrittenFiles: 2,
      agentWrittenLines: 80,
      generatedFiles: overrides.arm === "compiler" ? 60 : 0,
      generatedLines: overrides.arm === "compiler" ? 9_000 : 0,
      humanCorrections: 0,
      generatedCodeRewrites: 0,
    },
    outcome: { buildPassed: passed, testsPassed: passed, functionalChecksPassed: passed },
  };
}

async function writeRuns(directory: string, runs: Record<string, unknown>[]): Promise<void> {
  await Promise.all(
    runs.map((run, index) =>
      writeFile(join(directory, `run-${index}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8"),
    ),
  );
}

function completePair(): Record<string, unknown>[] {
  return [
    result({ arm: "direct", pairId: "p1", runId: "d1", tokens: { input: 9000, cached: 500, output: 4000, tool: 300 }, wallClockMs: 300_000 }),
    result({ arm: "direct", pairId: "p2", runId: "d2", tokens: { input: 9500, cached: 400, output: 4200, tool: 250 }, wallClockMs: 320_000 }),
    result({ arm: "direct", pairId: "p3", runId: "d3", tokens: { input: 8800, cached: 600, output: 3900, tool: 350 }, wallClockMs: 310_000 }),
    result({ arm: "compiler", pairId: "p1", runId: "c1", tokens: { input: 2000, cached: 200, output: 900, tool: 100 }, wallClockMs: 90_000 }),
    result({ arm: "compiler", pairId: "p2", runId: "c2", tokens: { input: 2100, cached: 150, output: 950, tool: 120 }, wallClockMs: 95_000 }),
    result({ arm: "compiler", pairId: "p3", runId: "c3", tokens: { input: 1900, cached: 250, output: 850, tool: 80 }, wallClockMs: 85_000 }),
  ];
}

describe("benchmark result validation", () => {
  it("accepts schema-valid paired results", async () => {
    const directory = await runsDirectory();
    await writeRuns(directory, completePair());
    const outcome = runScript(validateScript, directory);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("run-0.json: valid");
  });

  it("rejects results missing the paired-evidence protocol block", async () => {
    const directory = await runsDirectory();
    const invalid = result({ arm: "direct", pairId: "p1", runId: "d1" });
    delete (invalid as Record<string, unknown>).protocol;
    await writeRuns(directory, [invalid]);
    const outcome = runScript(validateScript, directory);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("protocol");
  });

  it("rejects token counts that are not integers or null", async () => {
    const directory = await runsDirectory();
    const invalid = result({ arm: "direct", pairId: "p1", runId: "d1" }) as {
      measurements: Record<string, unknown>;
    };
    invalid.measurements.inputTokens = "estimated-from-lines";
    await writeRuns(directory, [invalid as unknown as Record<string, unknown>]);
    const outcome = runScript(validateScript, directory);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("inputTokens");
  });

  it("treats an empty runs directory as no data, not as evidence", async () => {
    const directory = await runsDirectory();
    const outcome = runScript(validateScript, directory);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("No benchmark runs found");
  });
});

describe("benchmark summarization", () => {
  it("summarizes a complete pair with separated token, time, and correctness sections", async () => {
    const directory = await runsDirectory();
    await writeRuns(directory, completePair());
    const outcome = runScript(summarizeScript, directory);
    expect(outcome.status).toBe(0);
    const summary = JSON.parse(outcome.stdout);
    expect(summary.note).toContain("never a token claim");
    const group = summary.summaries[0];
    expect(group.correctness.direct).toMatchObject({ runs: 3, successful: 3, failedRunIds: [] });
    expect(group.pairs).toBe(3);
    expect(group.successfulPairs).toBe(3);
    expect(group.tokenComparison.evidence).toBe("complete");
    expect(group.tokenComparison.arms.direct.medianInputPlusOutputTokens).toBe(9000 + 4000);
    expect(group.tokenComparison.arms.direct.medianCachedInputTokens).toBe(500);
    expect(group.tokenComparison.medianPairedInputPlusOutputChangePercent).toBeLessThan(0);
    expect(group.timeComparison.medianWallClockMs.compiler).toBe(90_000);
    expect(group.timeComparison.medianPairedWallClockChangePercent).toBeLessThan(0);
  });

  it("refuses groups with fewer than three runs per arm", async () => {
    const directory = await runsDirectory();
    await writeRuns(directory, completePair().slice(0, 5));
    const outcome = runScript(summarizeScript, directory);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("must contain one direct and one compiler run");
  });

  it("keeps failed runs visible and out of medians without hiding them", async () => {
    const directory = await runsDirectory();
    const runs = completePair();
    runs.push(
      result({ arm: "direct", pairId: "p4", runId: "d4", wallClockMs: 100_000 }),
      result({ arm: "compiler", pairId: "p4", runId: "c4-failed", passed: false, tokens: { input: 1, cached: 0, output: 1, tool: 0 }, wallClockMs: 1 }),
    );
    await writeRuns(directory, runs);
    const outcome = runScript(summarizeScript, directory);
    expect(outcome.status).toBe(0);
    const group = JSON.parse(outcome.stdout).summaries[0];
    expect(group.correctness.compiler).toMatchObject({ runs: 4, successful: 3, failedRunIds: ["c4-failed"] });
    expect(group.correctness.compiler.successRatePercent).toBe(75);
    expect(group.tokenComparison.arms.compiler.medianInputPlusOutputTokens).toBe(2000 + 900);
  });

  it("reports no token percentage when a successful run lacks provider accounting", async () => {
    const directory = await runsDirectory();
    const runs = completePair();
    (runs[3] as { measurements: Record<string, unknown> }).measurements.cachedInputTokens = null;
    await writeRuns(directory, runs);
    const outcome = runScript(summarizeScript, directory);
    expect(outcome.status).toBe(0);
    const group = JSON.parse(outcome.stdout).summaries[0];
    expect(group.tokenComparison.evidence).toBe("incomplete");
    expect(group.tokenComparison.medianPairedInputPlusOutputChangePercent).toBeNull();
    expect(group.tokenComparison.arms.compiler.medianInputPlusOutputTokens).toBeNull();
    expect(group.tokenComparison.note).toContain("no token comparison");
    expect(group.timeComparison.medianPairedWallClockChangePercent).toBeLessThan(0);
  });

  it("refuses schema-invalid files instead of summarizing them", async () => {
    const directory = await runsDirectory();
    const runs = completePair();
    (runs[0] as Record<string, unknown>).schemaVersion = "backendcompiler.dev/benchmark-result/v1";
    await writeRuns(directory, runs);
    const outcome = runScript(summarizeScript, directory);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("does not satisfy the benchmark result schema");
  });

  it("never merges different models into one comparison", async () => {
    const directory = await runsDirectory();
    const runs = completePair();
    runs[3] = result({ arm: "compiler", pairId: "p1", runId: "c1", model: "other-model-2026-02-02" });
    await writeRuns(directory, runs);
    const outcome = runScript(summarizeScript, directory);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("must contain one direct and one compiler run");
  });

  it("refuses duplicate run ids and protocol drift", async () => {
    const directory = await runsDirectory();
    const runs = completePair();
    (runs[1] as { runId: string }).runId = "d1";
    (runs[2] as { protocol: Record<string, unknown> }).protocol.maxAttempts = 4;
    await writeRuns(directory, runs);
    const validation = runScript(validateScript, directory);
    expect(validation.status).toBe(1);
    expect(validation.stderr).toContain("duplicate runId");
    expect(validation.stderr).toContain("maxAttempts");
  });

  it("rejects invalid execution positions inside a pair", async () => {
    const directory = await runsDirectory();
    const runs = completePair();
    (runs[0] as { pairPosition: string }).pairPosition = "first";
    (runs[3] as { pairPosition: string }).pairPosition = "first";
    await writeRuns(directory, runs);
    const validation = runScript(validateScript, directory);
    expect(validation.status).toBe(1);
    expect(validation.stderr).toContain("positions must be first/second");
  });

  it("requires at least three successful pairs before reporting performance", async () => {
    const directory = await runsDirectory();
    const runs = completePair();
    (runs[3] as { outcome: Record<string, unknown> }).outcome.testsPassed = false;
    await writeRuns(directory, runs);
    const outcome = runScript(summarizeScript, directory);
    expect(outcome.status).toBe(0);
    const group = JSON.parse(outcome.stdout).summaries[0];
    expect(group.successfulPairs).toBe(2);
    expect(group.tokenComparison.evidence).toBe("incomplete");
    expect(group.timeComparison.evidence).toBe("insufficient");
    expect(group.tokenComparison.medianPairedInputPlusOutputChangePercent).toBeNull();
    expect(group.timeComparison.medianPairedWallClockChangePercent).toBeNull();
  });
});
