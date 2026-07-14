import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const rows = [];

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path.includes("node_modules/") || !entry.version) continue;
  const packageJsonPath = join(root, path, "package.json");
  let metadata = entry;
  try {
    metadata = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    // The lock file remains the source of truth when dependencies are not installed.
  }
  const name = metadata.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
  const license = Array.isArray(metadata.licenses)
    ? metadata.licenses.map((item) => item.type ?? item).join(" OR ")
    : metadata.license ?? entry.license ?? "UNKNOWN";
  rows.push({ name, version: entry.version, license: String(license) });
}

rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const unique = rows.filter(
  (row, index) => index === 0 || row.name !== rows[index - 1].name || row.version !== rows[index - 1].version,
);
const lines = [
  "# Third-Party Licenses",
  "",
  "Generated deterministically from `package-lock.json` by `npm run licenses`.",
  "Review entries marked `UNKNOWN` before a release.",
  "",
  "| Package | Version | License |",
  "|---|---:|---|",
  ...unique.map(({ name, version, license }) =>
    `| ${name.replaceAll("|", "\\|")} | ${version} | ${license.replaceAll("|", "\\|")} |`,
  ),
  "",
];
const output = join(root, "THIRD_PARTY_LICENSES.md");
await writeFile(output, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${relative(root, output)} (${unique.length} packages).`);
if (unique.some((row) => row.license === "UNKNOWN")) process.exitCode = 1;
