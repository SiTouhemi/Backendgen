import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePaths = [
  resolve(root, "apps", "distribution", "package.json"),
  resolve(root, "apps", "mcp-distribution", "package.json"),
];
const serverPath = resolve(root, "apps", "mcp-distribution", "server.json");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || process.argv[index + 1] === undefined) return undefined;
  return process.argv[index + 1];
}

const owner = argument("github-owner") ?? process.argv[2];
const repositoryName = argument("github-repo") ?? process.argv[3] ?? "backend-compiler";
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("dry-run");

if (owner === undefined) {
  throw new Error(
    "Provide the GitHub owner as the first argument. It must match the account used with mcp-publisher.",
  );
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
  throw new Error("--github-owner is not a valid GitHub user or organization name");
}
if (!/^[A-Za-z0-9._-]+$/.test(repositoryName)) {
  throw new Error("--github-repo contains unsupported characters");
}

const registryName = `io.github.${owner.toLowerCase()}/backendgen`;
const repositoryUrl = `https://github.com/${owner}/${repositoryName}`;

const packages = [];
for (const packagePath of packagePaths) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.repository = { type: "git", url: `${repositoryUrl}.git` };
  packageJson.homepage = `${repositoryUrl}#readme`;
  packageJson.bugs = { url: `${repositoryUrl}/issues` };
  if (packageJson.name === "backendgen-mcp") packageJson.mcpName = registryName;
  if (!dryRun) {
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }
  packages.push(packageJson);
}
const packageJson = packages.find((candidate) => candidate.name === "backendgen-mcp");
if (packageJson === undefined) throw new Error("Missing backendgen-mcp package metadata");

const server = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: registryName,
  title: "BackendGen",
  description:
    "Validate compact backend specifications and generate tested NestJS, Prisma, and PostgreSQL repositories.",
  repository: { url: repositoryUrl, source: "github" },
  version: packageJson.version,
  packages: [
    {
      registryType: "npm",
      identifier: packageJson.name,
      version: packageJson.version,
      transport: { type: "stdio" },
      environmentVariables: [
        {
          name: "BACKENDGEN_ALLOWED_ROOTS",
          description:
            "Optional list of filesystem roots BackendGen may read and write, separated by ';' (or ':' between POSIX absolute paths).",
          isRequired: false,
          isSecret: false,
          format: "string",
        },
      ],
    },
  ],
};

if (!dryRun) {
  await writeFile(serverPath, `${JSON.stringify(server, null, 2)}\n`, "utf8");
}
process.stdout.write(
  `${dryRun ? "Validated" : "Prepared"} MCP Registry metadata\nRegistry name: ${registryName}\n`,
);
