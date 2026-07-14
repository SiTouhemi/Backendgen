import { spawn } from "node:child_process";
import { GENERATOR_NAME } from "@backend-compiler/common";
import { access, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { hashContents, readManifest } from "./manifest.js";
import { assertSafeRelativePath } from "./plan.js";

export interface CommandResult {
  command: string;
  exitCode: number;
  /** Truncated to `maxOutputBytes`; generated projects can produce a lot of output. */
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface TestSummary {
  passed: number;
  failed: number;
  total: number;
}

export interface RunTestsOptions {
  outputDirectory: string;
  /** Also run the integration suite, which needs a reachable database. */
  integration?: boolean;
  /** Run `npm ci`/`npm install` first. */
  install?: boolean;
  maxOutputBytes?: number;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RunTestsResult {
  success: boolean;
  tests: TestSummary;
  commands: CommandResult[];
}

const DEFAULT_MAX_OUTPUT = 16_000;
const DEFAULT_TIMEOUT = 15 * 60 * 1000;

function failedPreflight(output: string, started: number): CommandResult {
  return {
    command: "verify generated manifest",
    exitCode: 1,
    output,
    truncated: false,
    durationMs: Date.now() - started,
  };
}

/**
 * Test execution is code execution. Refuse arbitrary package directories and
 * locally modified generated scripts; custom-scaffold files intentionally stay
 * editable because they are the documented extension surface.
 */
async function verifyGeneratedProject(outputDirectory: string): Promise<CommandResult> {
  const started = Date.now();
  const manifest = await readManifest(outputDirectory);

  if (manifest === null || manifest.generator.name !== GENERATOR_NAME) {
    return failedPreflight(
      "Not a valid backendgen project. Generate it before running generated tests.",
      started,
    );
  }

  const root = await realpath(outputDirectory).catch(() => null);
  if (root === null) {
    return failedPreflight("Generated project directory does not exist.", started);
  }

  const generated = manifest.files.filter((entry) => entry.ownership === "generated");
  if (!generated.some((entry) => entry.path === "package.json")) {
    return failedPreflight("Generation manifest does not own package.json.", started);
  }

  for (const entry of generated) {
    if (assertSafeRelativePath(entry.path) !== null) {
      return failedPreflight("Generation manifest contains an unsafe file path.", started);
    }

    const absolute = join(root, entry.path);
    const resolved = await realpath(absolute).catch(() => null);
    if (resolved === null) {
      return failedPreflight(`Generated file is missing: ${entry.path}`, started);
    }

    const fromRoot = relative(root, resolved);
    if (fromRoot.startsWith("..") || fromRoot === "") {
      return failedPreflight("A generated file resolves outside the project directory.", started);
    }

    const contents = await readFile(resolved, "utf8").catch(() => null);
    if (contents === null || hashContents(contents) !== entry.hash) {
      return failedPreflight(
        `Generated file was modified after generation: ${entry.path}. Regenerate it first.`,
        started,
      );
    }
  }

  return {
    command: "verify generated manifest",
    exitCode: 0,
    output: "Generated project manifest verified.",
    truncated: false,
    durationMs: Date.now() - started,
  };
}

function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  maxOutputBytes: number;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks: string[] = [];
    let size = 0;
    let truncated = false;

    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      timeout: input.timeoutMs,
    });

    const collect = (data: Buffer): void => {
      const text = data.toString("utf8");
      if (size >= input.maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = input.maxOutputBytes - size;
      chunks.push(text.slice(0, remaining));
      size += Math.min(text.length, remaining);
      if (text.length > remaining) truncated = true;
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (error) => {
      resolve({
        command: `${input.command} ${input.args.join(" ")}`,
        exitCode: 1,
        output: `${chunks.join("")}\n${error.message}`,
        truncated,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      resolve({
        command: `${input.command} ${input.args.join(" ")}`,
        exitCode: code ?? 1,
        output: chunks.join(""),
        truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Jest prints its totals in a stable form. Parsing them keeps the structured
 * result small: agents get counts, not a wall of log output.
 */
export function parseJestSummary(output: string): TestSummary {
  const line = /Tests:\s+(.*)/g;
  const summary: TestSummary = { passed: 0, failed: 0, total: 0 };

  for (const match of output.matchAll(line)) {
    const body = match[1] ?? "";
    const passed = /(\d+)\s+passed/.exec(body);
    const failed = /(\d+)\s+failed/.exec(body);
    const total = /(\d+)\s+total/.exec(body);

    summary.passed += passed ? Number.parseInt(passed[1] as string, 10) : 0;
    summary.failed += failed ? Number.parseInt(failed[1] as string, 10) : 0;
    summary.total += total ? Number.parseInt(total[1] as string, 10) : 0;
  }

  return summary;
}

function summarizeTests(commands: readonly CommandResult[]): TestSummary {
  return commands
    .filter((command) => /(?:npm|npm-cli\.js) (?:run )?test(?:$|:|\s)/.test(command.command))
    .map((command) => parseJestSummary(command.output))
    .reduce<TestSummary>(
      (accumulator, summary) => ({
        passed: accumulator.passed + summary.passed,
        failed: accumulator.failed + summary.failed,
        total: accumulator.total + summary.total,
      }),
      { passed: 0, failed: 0, total: 0 },
    );
}

/** Runs the generated project's own test suites and reports counts, not logs. */
export async function runGeneratedTests(options: RunTestsOptions): Promise<RunTestsResult> {
  const cwd = options.outputDirectory;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;

  // Never inherit the compiler process's secrets into the generated project.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    WINDIR: process.env.WINDIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: "test",
    ...options.env,
  };

  const commands: CommandResult[] = [];
  commands.push(await verifyGeneratedProject(cwd));
  if (commands[0]!.exitCode !== 0) {
    return { success: false, tests: { passed: 0, failed: 0, total: 0 }, commands };
  }

  const npmExecPath = process.env.npm_execpath;
  const run = (args: string[]): Promise<CommandResult> =>
    npmExecPath
      ? runCommand({
          command: process.execPath,
          args: [npmExecPath, ...args],
          cwd,
          maxOutputBytes,
          timeoutMs,
          env,
        })
      : runCommand({
          command: process.platform === "win32" ? "npm.cmd" : "npm",
          args,
          cwd,
          maxOutputBytes,
          timeoutMs,
          env,
        });

  if (options.install === true) {
    const hasLock = await access(join(cwd, "package-lock.json"))
      .then(() => true)
      .catch(() => false);

    commands.push(await run([hasLock ? "ci" : "install"]));

    if (commands[commands.length - 1]!.exitCode !== 0) {
      return { success: false, tests: { passed: 0, failed: 0, total: 0 }, commands };
    }

    commands.push(await run(["run", "db:generate"]));
    if (commands[commands.length - 1]!.exitCode !== 0) {
      return { success: false, tests: { passed: 0, failed: 0, total: 0 }, commands };
    }
    commands.push(await run(["run", "db:validate"]));
    if (commands[commands.length - 1]!.exitCode !== 0) {
      return { success: false, tests: { passed: 0, failed: 0, total: 0 }, commands };
    }
    commands.push(await run(["run", "build"]));
    if (commands[commands.length - 1]!.exitCode !== 0) {
      return { success: false, tests: { passed: 0, failed: 0, total: 0 }, commands };
    }
  }

  commands.push(await run(["test"]));

  if (options.integration === true) {
    commands.push(await run(["run", "db:deploy"]));
    if (commands[commands.length - 1]!.exitCode !== 0) {
      return { success: false, tests: summarizeTests(commands), commands };
    }
    commands.push(await run(["run", "test:integration"]));
  }

  const tests = summarizeTests(commands);

  return {
    success: commands.every((command) => command.exitCode === 0),
    tests,
    commands,
  };
}
