import type { TargetRenderContext } from "@backend-compiler/target-sdk";
import { describe, expect, it } from "vitest";
import { jobsRenderer } from "./render.js";

function render() {
  return jobsRenderer.render({
    config: {
      maxAttempts: 3,
      pollIntervalMs: 5_000,
      retentionDays: 7,
      cron: [{ name: "heartbeat", schedule: "*/5 * * * *" }],
    },
    settings: { apiPrefix: "api" },
  } as unknown as TargetRenderContext);
}

function contents(path: string): string {
  const generated = render().files.find((file) => file.path === path);
  if (generated === undefined) throw new Error(`Missing rendered file ${path}`);
  return generated.contents;
}

describe("jobs renderer", () => {
  it("consumes attempts at claim time and fails exhausted rows before handlers", () => {
    const runner = contents("src/generated/jobs/job.runner.ts");

    expect(runner).toContain("attempts: { gte: MAX_ATTEMPTS }");
    expect(runner).toContain("attempts: { increment: 1 }");
    expect(runner).toContain("lastError: 'retry-limit-reached'");
    expect(runner).toContain("const attempt = row.attempts;");
    expect(runner).not.toContain("const attempt = row.attempts + 1");
  });

  it("bounds payloads and retains neither successful nor failed terminal rows forever", () => {
    const service = contents("src/generated/jobs/job.service.ts");
    const runner = contents("src/generated/jobs/job.runner.ts");

    expect(service).toContain("Buffer.byteLength(serialized, 'utf8')");
    expect(service).toContain("Job payload must not exceed 64 KiB");
    expect(runner).toContain("status: { in: ['DONE', 'FAILED'] }");
  });

  it("anchors star steps to the minimum of one-based cron fields", () => {
    const cron = contents("src/generated/jobs/cron.ts");

    expect(cron).toContain("(value - minimum) % Number(step[1]) === 0");
    expect(cron).toContain("fieldMatches(month, date.getUTCMonth() + 1, 1)");
    expect(cron).toContain("fieldMatches(dayOfMonth, date.getUTCDate(), 1)");
  });
});
