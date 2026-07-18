import { access, chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  {
    input: resolve(root, "apps", "cli", "dist", "src", "index.js"),
    packageRoot: resolve(root, "apps", "distribution"),
    outputName: "backendgen.cjs",
  },
  {
    input: resolve(root, "apps", "mcp-server", "dist", "src", "index.js"),
    packageRoot: resolve(root, "apps", "mcp-distribution"),
    outputName: "backendgen-mcp.cjs",
  },
];

for (const entry of entries) {
  try {
    await access(entry.input);
  } catch {
    throw new Error(`Missing compiled entry ${entry.input}. Run npm run build first.`);
  }
}

for (const entry of entries) {
  const outputRoot = resolve(entry.packageRoot, "dist");
  const output = resolve(outputRoot, entry.outputName);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await build({
    entryPoints: [entry.input],
    outfile: output,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    legalComments: "none",
    sourcemap: false,
  });
  await chmod(output, 0o755);
  await copyFile(resolve(root, "LICENSE"), resolve(entry.packageRoot, "LICENSE"));
  await copyFile(resolve(root, "NOTICE"), resolve(entry.packageRoot, "NOTICE"));
}

process.stdout.write("Bundled BackendGen CLI and MCP distributions\n");
