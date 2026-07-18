import Ajv2020 from "ajv/dist/2020.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directoryArgumentIndex = process.argv.indexOf("--dir");
if (directoryArgumentIndex >= 0 && !process.argv[directoryArgumentIndex + 1]) {
  throw new Error("--dir requires a directory path");
}
const explicitDirectory = directoryArgumentIndex >= 0;
const directory = explicitDirectory
  ? resolve(process.argv[directoryArgumentIndex + 1])
  : fileURLToPath(new URL("./runs/", import.meta.url));

const schema = JSON.parse(
  await readFile(new URL("./result.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

let files = [];
try {
  files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
} catch (error) {
  if (!explicitDirectory && error?.code === "ENOENT") {
    files = [];
  } else {
    throw error;
  }
}

if (files.length === 0) {
  console.log("No benchmark runs found. The committed template is intentionally not treated as data.");
  process.exit(0);
}

const results = [];
for (const file of files) {
  const value = JSON.parse(await readFile(resolve(directory, file), "utf8"));
  if (!validate(value)) {
    console.error(`${file}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
    process.exitCode = 1;
  } else {
    console.log(`${file}: valid`);
    results.push({ file, value });
  }
}

if (process.exitCode === 1) process.exit(1);

const issues = [];
const runIds = new Map();
const groups = new Map();
for (const result of results) {
  const previous = runIds.get(result.value.runId);
  if (previous) {
    issues.push(`duplicate runId '${result.value.runId}' in ${previous} and ${result.file}`);
  } else {
    runIds.set(result.value.runId, result.file);
  }
  if (result.value.measurements.attempts > result.value.protocol.maxAttempts) {
    issues.push(
      `${result.file}: measurements.attempts exceeds protocol.maxAttempts`,
    );
  }

  const key = [
    result.value.model,
    result.value.agent.name,
    result.value.agent.version,
    result.value.scenario,
  ].join("\u0000");
  const group = groups.get(key) ?? [];
  group.push(result);
  groups.set(key, group);
}

for (const group of groups.values()) {
  const label = `${group[0].value.model}/${group[0].value.agent.name}@${group[0].value.agent.version}/${group[0].value.scenario}`;
  for (const field of ["requirementsFile", "suppliedContext", "startingRepoState", "maxAttempts", "environment"]) {
    const values = group.map((result) =>
      field === "environment"
        ? JSON.stringify(result.value.protocol.environment)
        : result.value.protocol[field],
    );
    if (new Set(values).size > 1) {
      issues.push(`${label}: controlled protocol field '${field}' drifts across runs`);
    }
  }
  for (const arm of ["direct", "compiler"]) {
    const prompts = new Set(
      group
        .filter((result) => result.value.arm === arm)
        .map((result) => result.value.protocol.promptFile),
    );
    if (prompts.size > 1) issues.push(`${label}: ${arm} promptFile drifts across runs`);
  }

  const seenPairArms = new Map();
  const pairs = new Map();
  for (const result of group) {
    const pairArm = `${result.value.pairId}\u0000${result.value.arm}`;
    const previous = seenPairArms.get(pairArm);
    if (previous) {
      issues.push(
        `${label}: pair '${result.value.pairId}' has duplicate ${result.value.arm} runs in ${previous} and ${result.file}`,
      );
    } else {
      seenPairArms.set(pairArm, result.file);
    }
    const pair = pairs.get(result.value.pairId) ?? {};
    pair[result.value.arm] = result.value;
    pairs.set(result.value.pairId, pair);
  }
  for (const [pairId, pair] of pairs) {
    if (!pair.direct || !pair.compiler) continue;
    const positions = new Set([pair.direct.pairPosition, pair.compiler.pairPosition]);
    const validPositions =
      (positions.size === 1 && positions.has("independent")) ||
      (positions.size === 2 && positions.has("first") && positions.has("second"));
    if (!validPositions) {
      issues.push(
        `${label}: pair '${pairId}' positions must be first/second or independent/independent`,
      );
    }
  }
}

if (issues.length > 0) {
  console.error(`Benchmark evidence is inconsistent:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  process.exit(1);
}
