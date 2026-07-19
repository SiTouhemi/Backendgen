import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePaths = [
  resolve(root, "apps", "distribution", "package.json"),
  resolve(root, "apps", "mcp-distribution", "package.json"),
];
const serverPath = resolve(root, "apps", "mcp-distribution", "server.json");
const CLI_PACKAGE_NAME = "@2hemi/backendgen";
const MCP_PACKAGE_NAME = "@2hemi/backendgen-mcp";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || process.argv[index + 1] === undefined) return undefined;
  return process.argv[index + 1];
}

const owner = argument("github-owner") ?? process.argv[2];
const repositoryName = argument("github-repo") ?? process.argv[3] ?? "Backendgen";
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

// GitHub OIDC namespace grants preserve the login's canonical case. The MCP
// Registry compares this prefix case-sensitively (for example,
// io.github.SiTouhemi/*), so lowercasing a valid GitHub owner breaks publish.
const registryName = `io.github.${owner}/backendgen`;
const repositoryUrl = `https://github.com/${owner}/${repositoryName}`;

const packages = [];
for (const packagePath of packagePaths) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.repository = { type: "git", url: `git+${repositoryUrl}.git` };
  packageJson.homepage = `${repositoryUrl}#readme`;
  packageJson.bugs = { url: `${repositoryUrl}/issues` };
  if (packageJson.name === MCP_PACKAGE_NAME) packageJson.mcpName = registryName;
  if (!dryRun) {
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }
  packages.push(packageJson);
}
const packageJson = packages.find((candidate) => candidate.name === MCP_PACKAGE_NAME);
if (packageJson === undefined) throw new Error(`Missing ${MCP_PACKAGE_NAME} package metadata`);
if (!packages.some((candidate) => candidate.name === CLI_PACKAGE_NAME)) {
  throw new Error(`Missing ${CLI_PACKAGE_NAME} package metadata`);
}

// The 2025-12-11 server schema caps description at 100 characters.
const MAX_DESCRIPTION_LENGTH = 100;
const serverDescription =
  "Validate compact backend specs and generate tested NestJS, Prisma, and PostgreSQL repositories.";
if (serverDescription.length > MAX_DESCRIPTION_LENGTH) {
  throw new Error(
    `server.json description is ${serverDescription.length} characters; the MCP Registry schema allows at most ${MAX_DESCRIPTION_LENGTH}`,
  );
}

const server = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: registryName,
  title: "BackendGen",
  description: serverDescription,
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
