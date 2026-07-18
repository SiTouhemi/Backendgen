import Ajv2020 from "ajv/dist/2020.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directoryArgumentIndex = process.argv.indexOf("--dir");
if (directoryArgumentIndex >= 0 && !process.argv[directoryArgumentIndex + 1]) {
  throw new Error("--dir requires a directory path");
}
const explicitDirectory = directoryArgumentIndex >= 0;
const runDirectory = explicitDirectory
  ? resolve(process.argv[directoryArgumentIndex + 1])
  : fileURLToPath(new URL("./runs/", import.meta.url));

const schema = JSON.parse(
  await readFile(new URL("./result.schema.json", import.meta.url), "utf8"),
);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

let files = [];
try {
  files = (await readdir(runDirectory)).filter((name) => name.endsWith(".json")).sort();
} catch (error) {
  if (!explicitDirectory && error?.code === "ENOENT") files = [];
  else throw error;
}

const results = [];
const runIds = new Set();
for (const file of files) {
  const value = JSON.parse(await readFile(resolve(runDirectory, file), "utf8"));
  if (!validate(value)) {
    throw new Error(
      `${file} does not satisfy the benchmark result schema; run npm run benchmark:validate`,
    );
  }
  if (runIds.has(value.runId)) throw new Error(`duplicate benchmark runId '${value.runId}'`);
  if (value.measurements.attempts > value.protocol.maxAttempts) {
    throw new Error(`${file}: measurements.attempts exceeds protocol.maxAttempts`);
  }
  runIds.add(value.runId);
  results.push(value);
}

if (results.length === 0) {
  process.stdout.write("No benchmark runs found. No token-saving claim can be calculated.\n");
  process.exit(0);
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function succeeded(run) {
  return run.outcome.buildPassed && run.outcome.testsPassed && run.outcome.functionalChecksPassed;
}

const TOKEN_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "toolCallTokens"];
function hasCompleteTokenAccounting(run) {
  return TOKEN_FIELDS.every((field) => run.measurements[field] !== null);
}
function inputPlusOutputTokens(run) {
  return run.measurements.inputTokens + run.measurements.outputTokens;
}
function changePercent(direct, compiler) {
  return direct === 0 ? null : ((compiler - direct) / direct) * 100;
}
function rounded(value) {
  return value == null ? null : Number(value.toFixed(1));
}

const groups = new Map();
for (const result of results) {
  const key = [result.model, result.agent.name, result.agent.version, result.scenario].join("\u0000");
  const group = groups.get(key) ?? {
    model: result.model,
    agent: result.agent,
    scenario: result.scenario,
    runs: [],
  };
  group.runs.push(result);
  groups.set(key, group);
}

const summaries = [];
for (const group of [...groups.values()].sort((left, right) =>
  `${left.model}/${left.agent.name}/${left.agent.version}/${left.scenario}`.localeCompare(
    `${right.model}/${right.agent.name}/${right.agent.version}/${right.scenario}`,
  ),
)) {
  const label = `${group.model}/${group.agent.name}@${group.agent.version}/${group.scenario}`;
  for (const field of ["requirementsFile", "suppliedContext", "startingRepoState", "maxAttempts", "environment"]) {
    const values = group.runs.map((run) =>
      field === "environment" ? JSON.stringify(run.protocol.environment) : run.protocol[field],
    );
    if (new Set(values).size > 1) {
      throw new Error(`${label}: controlled protocol field '${field}' drifts across runs`);
    }
  }
  for (const arm of ["direct", "compiler"]) {
    if (
      new Set(
        group.runs.filter((run) => run.arm === arm).map((run) => run.protocol.promptFile),
      ).size > 1
    ) {
      throw new Error(`${label}: ${arm} promptFile drifts across runs`);
    }
  }

  const pairMap = new Map();
  for (const run of group.runs) {
    const pair = pairMap.get(run.pairId) ?? {};
    if (pair[run.arm]) {
      throw new Error(`${label}: pair '${run.pairId}' has duplicate ${run.arm} runs`);
    }
    pair[run.arm] = run;
    pairMap.set(run.pairId, pair);
  }
  for (const [pairId, pair] of pairMap) {
    if (!pair.direct || !pair.compiler) {
      throw new Error(`${label}: pair '${pairId}' must contain one direct and one compiler run`);
    }
    const positions = new Set([pair.direct.pairPosition, pair.compiler.pairPosition]);
    const validPositions =
      (positions.size === 1 && positions.has("independent")) ||
      (positions.size === 2 && positions.has("first") && positions.has("second"));
    if (!validPositions) {
      throw new Error(
        `${label}: pair '${pairId}' positions must be first/second or independent/independent`,
      );
    }
  }
  const pairs = [...pairMap.entries()].map(([pairId, pair]) => ({ pairId, ...pair }));
  if (pairs.length < 3) {
    throw new Error(`${label} needs at least three complete direct/compiler pairs`);
  }

  const arms = Object.fromEntries(
    ["direct", "compiler"].map((arm) => [arm, group.runs.filter((run) => run.arm === arm)]),
  );
  const correctness = Object.fromEntries(
    Object.entries(arms).map(([arm, runs]) => {
      const successful = runs.filter(succeeded).length;
      return [
        arm,
        {
          runs: runs.length,
          successful,
          successRatePercent: rounded((successful / runs.length) * 100),
          failedRunIds: runs.filter((run) => !succeeded(run)).map((run) => run.runId),
        },
      ];
    }),
  );

  const successfulPairs = pairs.filter(
    (pair) => succeeded(pair.direct) && succeeded(pair.compiler),
  );
  const enoughSuccessfulPairs = successfulPairs.length >= 3;
  const timePairChanges = successfulPairs
    .map((pair) =>
      changePercent(pair.direct.measurements.wallClockMs, pair.compiler.measurements.wallClockMs),
    )
    .filter((value) => value !== null);
  const timeEvidence = enoughSuccessfulPairs && timePairChanges.length === successfulPairs.length;

  const completeTokenPairs = successfulPairs.filter(
    (pair) => hasCompleteTokenAccounting(pair.direct) && hasCompleteTokenAccounting(pair.compiler),
  );
  const tokenEvidence =
    enoughSuccessfulPairs && completeTokenPairs.length === successfulPairs.length;

  const tokenArms = Object.fromEntries(
    ["direct", "compiler"].map((arm) => {
      const runs = tokenEvidence ? completeTokenPairs.map((pair) => pair[arm]) : [];
      return [
        arm,
        {
          successfulRuns: successfulPairs.length,
          completeTokenRuns: completeTokenPairs.length,
          medianInputPlusOutputTokens:
            runs.length === 0 ? null : median(runs.map(inputPlusOutputTokens)),
          medianInputTokens:
            runs.length === 0 ? null : median(runs.map((run) => run.measurements.inputTokens)),
          medianCachedInputTokens:
            runs.length === 0
              ? null
              : median(runs.map((run) => run.measurements.cachedInputTokens)),
          medianOutputTokens:
            runs.length === 0 ? null : median(runs.map((run) => run.measurements.outputTokens)),
          medianToolCallTokens:
            runs.length === 0 ? null : median(runs.map((run) => run.measurements.toolCallTokens)),
        },
      ];
    }),
  );
  const tokenPairChanges = tokenEvidence
    ? completeTokenPairs
        .map((pair) =>
          changePercent(inputPlusOutputTokens(pair.direct), inputPlusOutputTokens(pair.compiler)),
        )
        .filter((value) => value !== null)
    : [];
  const tokenComparisonComplete =
    tokenEvidence && tokenPairChanges.length === completeTokenPairs.length;

  summaries.push({
    model: group.model,
    agent: group.agent,
    scenario: group.scenario,
    pairs: pairs.length,
    successfulPairs: successfulPairs.length,
    correctness,
    tokenComparison: {
      evidence: tokenComparisonComplete ? "complete" : "incomplete",
      arms: tokenArms,
      medianPairedInputPlusOutputChangePercent: tokenComparisonComplete
        ? rounded(median(tokenPairChanges))
        : null,
      note: tokenComparisonComplete
        ? "Cached-input and tool-call tokens are reported as provider breakdowns and are not added again to input-plus-output totals."
        : "At least three successful pairs with complete provider accounting and nonzero direct input-plus-output totals are required; no token comparison is reported.",
    },
    timeComparison: {
      evidence: timeEvidence ? "complete" : "insufficient",
      medianWallClockMs: {
        direct: timeEvidence
          ? median(successfulPairs.map((pair) => pair.direct.measurements.wallClockMs))
          : null,
        compiler: timeEvidence
          ? median(successfulPairs.map((pair) => pair.compiler.measurements.wallClockMs))
          : null,
      },
      medianPairedWallClockChangePercent: timeEvidence
        ? rounded(median(timePairChanges))
        : null,
      note: timeEvidence
        ? undefined
        : "At least three successful pairs with nonzero direct durations are required; no time comparison is reported.",
    },
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      note: "Token and time comparisons use matched direct/compiler pairs. Input totals already include cached-input breakdowns for providers that report them, so cached tokens are never double-counted. Deterministic expansion lives separately in benchmark/expansion.json and is never a token claim. Failed runs remain in correctness rates and are excluded from conditional performance medians.",
      summaries,
    },
    null,
    2,
  )}\n`,
);
