import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compileBackend,
  createDefaultRegistry,
  createDefaultTargets,
  renderBackend,
} from "../packages/generator-runtime/dist/src/index.js";
import { loadSpecFile } from "../packages/specification/dist/src/index.js";

const scenarios = [
  { name: "todo-crud", spec: "examples/notes-api/backend.yaml" },
  { name: "authentication", spec: "examples/auth-notes/backend.yaml" },
  { name: "multi-tenant-saas", spec: "examples/saas-tasks/backend.yaml" },
  { name: "hotel-booking", spec: "examples/hotel-booking/backend.yaml" },
  { name: "appointment-scheduling", spec: "examples/appointments/backend.yaml" },
];

function lines(value) {
  if (value.length === 0) return 0;
  const parts = value.split(/\r?\n/u);
  if (parts.at(-1) === "") parts.pop();
  return parts.length;
}

const features = createDefaultRegistry();
const targets = createDefaultTargets();
const measurements = [];

for (const scenario of scenarios) {
  const specPath = resolve(scenario.spec);
  const source = await readFile(specPath, "utf8");
  const spec = await loadSpecFile(specPath);
  const compiled = compileBackend(spec, { features, targets });
  if (!compiled.ok) {
    throw new Error(
      `${scenario.name} failed: ${compiled.issues
        .map((issue) => `[${issue.code}] ${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  }

  const rendered = renderBackend(compiled.value);
  const generatedBytes = rendered.files.reduce(
    (total, file) => total + Buffer.byteLength(file.contents, "utf8"),
    0,
  );
  const generatedLines = rendered.files.reduce(
    (total, file) => total + lines(file.contents),
    0,
  );
  const specBytes = Buffer.byteLength(source, "utf8");
  const specLines = lines(source);

  measurements.push({
    scenario: scenario.name,
    specification: scenario.spec.replaceAll("\\", "/"),
    specLines,
    specBytes,
    generatedFiles: rendered.files.length,
    generatedLines,
    generatedBytes,
    lineExpansion: Number((generatedLines / specLines).toFixed(1)),
    byteExpansion: Number((generatedBytes / specBytes).toFixed(1)),
  });
}

const result = {
  schemaVersion: "backendcompiler.dev/expansion-result/v1",
  generatorVersion: "0.2.0",
  note: "Deterministic representation expansion only; this is not an observed AI token benchmark.",
  scenarios: measurements,
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
const outputPath = resolve("benchmark", "expansion.json");

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== serialized) {
    throw new Error("benchmark/expansion.json is stale; run npm run benchmark:expansion");
  }
  process.stdout.write("Expansion evidence is current.\n");
} else {
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(`Wrote ${outputPath}\n`);
}
