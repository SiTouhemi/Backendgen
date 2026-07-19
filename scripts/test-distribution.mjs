import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error("Run this smoke test through `npm run test:distribution`");
}
const temporary = await mkdtemp(join(tmpdir(), "backendgen-distribution-"));
const packageDirectory = join(temporary, "packages");
const consumerDirectory = join(temporary, "consumer");
const CLI_PACKAGE = "@2hemi/backendgen";
const MCP_PACKAGE = "@2hemi/backendgen-mcp";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${signal ?? code})\n${stdout}${stderr}`,
        ),
      );
    });
  });
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCli, ...args], options);
}

// Exact contents each public tarball may ship. Anything else — TypeScript
// sources, .env files, fixtures, logs, maps — fails the smoke test.
const TARBALL_ALLOWLISTS = {
  [CLI_PACKAGE]: new Set(["package.json", "README.md", "LICENSE", "NOTICE", "dist/backendgen.cjs"]),
  [MCP_PACKAGE]: new Set([
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "dist/backendgen-mcp.cjs",
    // Present only after prepare:mcp-registry runs with the real GitHub owner.
    "server.json",
  ]),
};

const TARBALL_REQUIRED_FILES = {
  [CLI_PACKAGE]: ["package.json", "README.md", "LICENSE", "NOTICE", "dist/backendgen.cjs"],
  [MCP_PACKAGE]: [
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "dist/backendgen-mcp.cjs",
  ],
};

async function pack(workspace) {
  const { stdout } = await runNpm(
    [
      "pack",
      "--workspace",
      workspace,
      "--pack-destination",
      packageDirectory,
      "--ignore-scripts",
      "--json",
    ],
    { capture: true },
  );
  const result = JSON.parse(stdout);
  const filename = result[0]?.filename;
  if (typeof filename !== "string") throw new Error(`npm pack returned no file for ${workspace}`);

  const allowlist = TARBALL_ALLOWLISTS[workspace];
  const shipped = (result[0]?.files ?? []).map((file) => file.path);
  if (shipped.length === 0) throw new Error(`npm pack reported no files for ${workspace}`);
  const unexpected = shipped.filter((path) => !allowlist.has(path));
  if (unexpected.length > 0) {
    throw new Error(`${workspace} tarball ships unexpected files: ${unexpected.join(", ")}`);
  }
  for (const required of TARBALL_REQUIRED_FILES[workspace]) {
    if (!shipped.includes(required)) {
      throw new Error(`${workspace} tarball is missing ${required}`);
    }
  }

  return join(packageDirectory, filename);
}

/** Minimal stdio JSON-RPC driver so the packaged server is exercised end to end. */
class McpSession {
  constructor(serverEntry) {
    this.child = spawn(process.execPath, [serverEntry], {
      cwd: consumerDirectory,
      env: { ...process.env, BACKENDGEN_ALLOWED_ROOTS: consumerDirectory },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.stderr = "";
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          this.fail(new Error(`MCP emitted invalid JSON: ${line}\n${String(error)}`));
          return;
        }
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter(message);
        }
      }
    });
    this.child.once("exit", (code) => {
      this.fail(new Error(`MCP server exited early (${code})\n${this.stderr}`));
    });
    this.child.once("error", (error) => this.fail(error));
  }

  fail(error) {
    for (const waiter of this.pending.values()) waiter({ error: { message: String(error) } });
    this.pending.clear();
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`MCP request ${method} timed out\n${this.stderr}`)),
        30_000,
      );
      this.pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(`${method} failed: ${message.error.message}`));
        else resolvePromise(message.result);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text ?? "";
    if (Buffer.byteLength(text, "utf8") > 64_000) {
      throw new Error(`${name} response exceeded the 64 KB ceiling`);
    }
    return { isError: result?.isError === true, payload: text === "" ? null : JSON.parse(text) };
  }

  close() {
    this.child.removeAllListeners("exit");
    this.child.kill();
  }
}

async function testMcp(serverEntry) {
  const session = new McpSession(serverEntry);
  const spec = {
    specVersion: "backendcompiler.dev/v1",
    project: { name: "mcp-distribution-smoke" },
    target: { id: "nestjs-prisma", database: "postgresql" },
    entities: { Note: { fields: { title: "string" } } },
    features: { crud: {} },
  };
  const outputPath = join(consumerDirectory, "mcp-generated-api");

  try {
    const initialized = await session.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "backendgen-distribution-test", version: "1.0.0" },
    });
    if (initialized?.serverInfo?.name !== "backendgen") {
      throw new Error("Packaged MCP server did not identify as backendgen");
    }
    session.notify("notifications/initialized");

    const listed = await session.request("tools/list");
    const names = (listed?.tools ?? []).map((tool) => tool.name);
    for (const required of ["get_capabilities", "validate_spec", "generate_backend"]) {
      if (!names.includes(required)) throw new Error(`Packaged MCP server is missing tool ${required}`);
    }

    const capabilities = await session.callTool("get_capabilities", {});
    if (capabilities.isError || capabilities.payload?.specVersion !== "backendcompiler.dev/v1") {
      throw new Error("get_capabilities failed on the packaged server");
    }

    const validated = await session.callTool("validate_spec", { spec });
    if (validated.isError || validated.payload?.valid !== true) {
      throw new Error(`validate_spec failed: ${JSON.stringify(validated.payload)}`);
    }

    const preview = await session.callTool("preview_generation", { spec, outputPath });
    if (preview.isError || preview.payload?.dryRun !== true) {
      throw new Error(`preview_generation failed: ${JSON.stringify(preview.payload)}`);
    }

    const generated = await session.callTool("generate_backend", { spec, outputPath });
    if (generated.isError || generated.payload?.success !== true) {
      throw new Error(`generate_backend failed: ${JSON.stringify(generated.payload)}`);
    }
    const generatedText = JSON.stringify(generated.payload);
    if (generatedText.includes("@nestjs/common") || generatedText.includes("PrismaClient")) {
      throw new Error("generate_backend leaked generated source contents into its response");
    }

    const report = await session.callTool("get_generation_report", { outputPath });
    if (report.isError || typeof report.payload?.files?.total !== "number") {
      throw new Error(`get_generation_report failed: ${JSON.stringify(report.payload)}`);
    }

    const denied = await session.callTool("get_generation_report", {
      outputPath: join(temporary, "..", "escape-attempt"),
    });
    if (!denied.isError || denied.payload?.code !== "sandbox.denied") {
      throw new Error(`sandbox denial is not stable: ${JSON.stringify(denied.payload)}`);
    }
    if (JSON.stringify(denied.payload).match(/\n\s+at /)) {
      throw new Error("sandbox denial leaked a stack trace");
    }

    const malformed = await session.callTool("generate_backend", {
      spec,
      outputPath: 42,
      surprise: true,
    });
    if (!malformed.isError || malformed.payload?.code !== "tool.invalid-arguments") {
      throw new Error(`invalid arguments are not rejected: ${JSON.stringify(malformed.payload)}`);
    }
  } finally {
    session.close();
  }
}

try {
  await runNpm(["run", "bundle:distribution"]);
  await mkdir(packageDirectory);
  await mkdir(consumerDirectory);

  const cliPackage = await pack(CLI_PACKAGE);
  const mcpPackage = await pack(MCP_PACKAGE);

  await runNpm(["init", "--yes"], { cwd: consumerDirectory });
  await runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", cliPackage, mcpPackage],
    { cwd: consumerDirectory },
  );

  // Verify npm created both executable shims. Directly invoking bundle paths
  // alone would miss broken or normalized-away public `bin` metadata.
  const shimSuffix = process.platform === "win32" ? ".cmd" : "";
  await access(join(consumerDirectory, "node_modules", ".bin", `backendgen${shimSuffix}`));
  await access(join(consumerDirectory, "node_modules", ".bin", `backendgen-mcp${shimSuffix}`));
  const installedVersion = await runNpm(["exec", "--", "backendgen", "--version"], {
    cwd: consumerDirectory,
    capture: true,
  });
  if (installedVersion.stdout.trim() !== "0.2.1") {
    throw new Error(`Installed backendgen command reported: ${installedVersion.stdout.trim()}`);
  }

  const cliEntry = join(
    consumerDirectory,
    "node_modules",
    "@2hemi",
    "backendgen",
    "dist",
    "backendgen.cjs",
  );
  const mcpEntry = join(
    consumerDirectory,
    "node_modules",
    "@2hemi",
    "backendgen-mcp",
    "dist",
    "backendgen-mcp.cjs",
  );
  const spec = join(consumerDirectory, "backend.yaml");
  const output = join(consumerDirectory, "generated-api");

  await run(process.execPath, [cliEntry, "--help"], { cwd: consumerDirectory });
  const version = await run(process.execPath, [cliEntry, "--version"], {
    cwd: consumerDirectory,
    capture: true,
  });
  if (version.stdout.trim() !== "0.2.1") {
    throw new Error(`Packaged CLI reported unexpected version: ${version.stdout.trim()}`);
  }
  await run(process.execPath, [cliEntry, "init", spec, "--name", "distribution-smoke"], {
    cwd: consumerDirectory,
  });
  await run(process.execPath, [cliEntry, "validate", spec, "--json"], {
    cwd: consumerDirectory,
  });
  await run(process.execPath, [cliEntry, "generate", spec, "--output", output, "--json"], {
    cwd: consumerDirectory,
  });

  const frontendContract = JSON.parse(
    await readFile(join(output, "frontend-contract.json"), "utf8"),
  );
  if (frontendContract.schemaVersion !== "backendcompiler.dev/frontend-contract/v1") {
    throw new Error("Packaged CLI generated an invalid frontend contract");
  }

  // Both public schemas must be exportable from the packed tarball alone.
  const exportedSchemas = [
    ["spec", "backend-spec.v1.schema.json", "https://backendcompiler.dev/schema/backend-spec.v1.schema.json"],
    ["frontend", "frontend-contract.v1.schema.json", "https://backendcompiler.dev/schema/frontend-contract.v1.schema.json"],
  ];
  for (const [name, filename, id] of exportedSchemas) {
    const schemaPath = join(consumerDirectory, filename);
    await run(process.execPath, [cliEntry, "export-schema", name, "--output", schemaPath, "--json"], {
      cwd: consumerDirectory,
    });
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    if (schema.$id !== id) {
      throw new Error(`export-schema ${name} produced an unexpected schema: ${schema.$id}`);
    }
  }

  await testMcp(mcpEntry);
  process.stdout.write("Packaged BackendGen CLI and MCP smoke tests passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
