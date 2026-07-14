import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "apps/cli/dist/src/index.js");

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

describe("backendgen subprocess contract", () => {
  it("returns structured JSON and zero for a valid specification", () => {
    const result = run(["validate", "examples/hotel-booking/backend.yaml", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, specVersion: "backendcompiler.dev/v1" });
    expect(result.stderr).toBe("");
  });

  it("returns structured JSON and non-zero for an invalid command", () => {
    const result = run(["not-a-command", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: false });
  });

  it("accepts an absolute output path through the actual bin entry", () => {
    const output = resolve(root, ".tmp-cli-dry-run");
    const result = run([
      "generate", "examples/hotel-booking/backend.yaml", "--output", output, "--dry-run", "--json",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, outputPath: output });
  });
});
