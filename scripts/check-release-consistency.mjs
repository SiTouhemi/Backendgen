/**
 * Deterministic drift check across every place the product version appears,
 * plus a parse check of the workflow/action YAML. Run in development with
 * `npm run check:release`; release pipelines add `--release`, which also
 * requires a prepared `server.json`.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseMode = process.argv.includes("--release");
const failures = [];

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

const rootPackage = await json("package.json");
const expected = rootPackage.version;
const versions = [["package.json", expected]];

const versionSource = await readFile(resolve(root, "packages/common/src/version.ts"), "utf8");
const generatorVersion = versionSource.match(/GENERATOR_VERSION = "([^"]+)"/)?.[1];
versions.push(["packages/common/src/version.ts GENERATOR_VERSION", generatorVersion]);

for (const path of ["apps/distribution/package.json", "apps/mcp-distribution/package.json"]) {
  versions.push([path, (await json(path)).version]);
}

const yamlFiles = ["action.yml", ".github/workflows/ci.yml", ".github/workflows/release.yml"];
for (const path of yamlFiles) {
  try {
    const parsed = parseYaml(await readFile(resolve(root, path), "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      failures.push(`${path} did not parse to a YAML mapping`);
    } else if (path === "action.yml") {
      versions.push(["action.yml inputs.version.default", parsed.inputs?.version?.default]);
    }
  } catch (error) {
    failures.push(`${path} failed to parse as YAML: ${error.message}`);
  }
}

const serverJsonPath = resolve(root, "apps/mcp-distribution/server.json");
if (existsSync(serverJsonPath)) {
  const server = JSON.parse(await readFile(serverJsonPath, "utf8"));
  versions.push(["apps/mcp-distribution/server.json version", server.version]);
  versions.push(["apps/mcp-distribution/server.json packages[0].version", server.packages?.[0]?.version]);
  // The MCP Registry server schema (2025-12-11) rejects publishes with
  // description > 100 or title > 100 characters; catch that before the
  // release workflow reaches mcp-publisher.
  for (const [field, limit] of [["description", 100], ["title", 100]]) {
    const value = server[field];
    if (typeof value !== "string" || value.length === 0) {
      failures.push(`apps/mcp-distribution/server.json ${field} is missing`);
    } else if (value.length > limit) {
      failures.push(
        `apps/mcp-distribution/server.json ${field} is ${value.length} characters; the MCP Registry schema allows at most ${limit}`,
      );
    }
  }
} else if (releaseMode) {
  failures.push(
    "apps/mcp-distribution/server.json is missing. Run npm run prepare:mcp-registry with the final GitHub owner before releasing.",
  );
}

for (const [source, version] of versions) {
  if (version !== expected) {
    failures.push(`${source} is ${version ?? "missing"}, expected ${expected}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Release consistency check failed:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Release consistency check passed: ${versions.length} version sources agree on ${expected} (${releaseMode ? "release" : "development"} mode)\n`,
);
