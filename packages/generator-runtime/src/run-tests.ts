import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

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
