import type { FeatureEntityContext, FeatureEntityContribution, FeaturePack } from "@backend-compiler/feature-sdk";
import { TARGET_ID } from "@backend-compiler/target-nestjs-prisma";
import { jobsRenderer } from "./render.js";

export const JOBS_VERSION = "0.2.0";

export interface JobsConfig {
  maxAttempts: number;
  pollIntervalMs: number;
  retentionDays: number;
  cron: Array<{ name: string; schedule: string }>;
}

export function jobsConfig(raw: Record<string, unknown>): JobsConfig {
  return raw as unknown as JobsConfig;
}

/**
 * Validates one field of a five-field cron expression. Supported forms per
 * field: wildcard, step (star-slash-n), single values, `a-b` ranges and comma
 * lists. This is the exact grammar the generated runtime matcher implements —
 * accepting more here would generate schedules that silently never fire.
 */
function validCronField(field: string, min: number, max: number): boolean {
  if (field === "*") return true;

  const step = /^\*\/(\d{1,3})$/.exec(field);
  if (step) {
    const divisor = Number(step[1]);
    return divisor >= 1 && divisor <= max;
  }

  return field.split(",").every((part) => {
    const range = /^(\d{1,3})-(\d{1,3})$/.exec(part);
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      return low >= min && high <= max && low <= high;
    }
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= min && value <= max;
  });
}

const CRON_FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

export function validateCronExpression(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const range = CRON_FIELD_RANGES[index]!;
    return validCronField(field, range[0], range[1]);
  });
}

export const jobsFeature: FeaturePack = {
  name: "jobs",
  version: JOBS_VERSION,
  description:
    "Durable background jobs on PostgreSQL: transactional enqueue, leased multi-instance execution with persisted retry/backoff, deduplication keys, and cron schedules — no Redis or external queue.",
  dependsOn: [],
  conflictsWith: [],
  supportedTargets: [TARGET_ID],

  configSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      maxAttempts: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 5,
        description: "Execution attempts before a job is marked FAILED.",
      },
      pollIntervalMs: {
        type: "integer",
        minimum: 1000,
        maximum: 60000,
        default: 5000,
        description: "How often each instance polls for runnable jobs.",
      },
      retentionDays: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        default: 7,
        description: "Days completed jobs are kept before cleanup.",
      },
      cron: {
        type: "array",
        default: [],
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "schedule"],
          properties: {
            name: { type: "string", pattern: "^[a-z][a-z0-9_-]*$", maxLength: 64 },
            schedule: { type: "string", maxLength: 64 },
          },
        },
        description:
          "Recurring jobs. Five-field cron (minute hour day-of-month month day-of-week), UTC. Exactly one instance runs each occurrence.",
      },
    },
  },

  requiredEntities(): readonly string[] {
    return [];
  },

  validate(context: FeatureEntityContext) {
    const config = jobsConfig(context.config);
    const issues: Array<{ code: string; path: string; message: string }> = [];

    const seen = new Set<string>();
    for (const [index, entry] of (config.cron ?? []).entries()) {
      if (!validateCronExpression(entry.schedule)) {
        issues.push({
          code: "feature.jobs.invalid-cron",
          path: `/features/jobs/cron/${index}/schedule`,
          message:
            `'${entry.schedule}' is not a supported cron expression. Use five fields ` +
            "(minute hour day-of-month month day-of-week) with *, */n, values, ranges or comma lists.",
        });
      }
      if (seen.has(entry.name)) {
        issues.push({
          code: "feature.jobs.duplicate-cron-name",
          path: `/features/jobs/cron/${index}/name`,
          message: `Cron job '${entry.name}' is declared more than once.`,
        });
      }
      seen.add(entry.name);
    }

    return issues;
  },

  contributeEntities(): FeatureEntityContribution {
    return {
      create: [
        {
          name: "JobRecord",
          description:
            "One durable background job. Enqueued transactionally; executed by any instance under a lease.",
          origin: "feature",
          ownerFeature: "jobs",
          fields: [
            { name: "name", type: "string", required: true, internal: true },
            {
              name: "payload",
              type: "text",
              required: false,
              internal: true,
              description: "JSON payload. Cleared when the job reaches a terminal state.",
            },
            {
              name: "status",
              type: "string",
              required: true,
              enumValues: ["PENDING", "DONE", "FAILED"],
              defaultValue: "PENDING",
              internal: true,
            },
            { name: "attempts", type: "integer", required: true, defaultValue: 0, internal: true },
            { name: "nextAttemptAt", type: "datetime", required: true, internal: true },
            {
              name: "lockedUntil",
              type: "datetime",
              required: false,
              internal: true,
              description: "Claim lease; an expired lease lets another instance take over.",
            },
            {
              name: "dedupeKey",
              type: "string",
              required: false,
              internal: true,
              description:
                "Optional idempotency key. Two enqueues of the same (name, dedupeKey) yield one job.",
            },
            { name: "lastError", type: "string", required: false, internal: true },
          ],
          indexes: [
            { fields: ["status", "nextAttemptAt"], unique: false },
            { fields: ["name", "dedupeKey"], unique: true },
          ],
        },
      ],
    };
  },

  contribute(context) {
    const config = jobsConfig(context.config);
    void config;
    return {
      infrastructure: [
        {
          kind: "scheduler",
          name: "job-runner",
          feature: "jobs",
          reason:
            "Polls the JobRecord table and executes handlers under a lease. Runs in every instance; FOR UPDATE SKIP LOCKED keeps instances from processing the same job.",
          portabilityNote:
            "PostgreSQL row locking. A single-writer database would need a different claim strategy.",
        },
      ],
      customizationPoints: [
        {
          path: "src/custom/jobs.ts",
          feature: "jobs",
          contract: "JobHandler",
          description:
            "Register job handlers: provide CUSTOM_JOB_HANDLERS in CustomModule with a Map from job name to handler. Cron jobs and enqueued jobs dispatch to these handlers.",
        },
      ],
    };
  },

  renderers: { [TARGET_ID]: jobsRenderer },

  agentSummary:
    "Durable PostgreSQL-backed background jobs. Creates the JobRecord entity. Enqueue transactionally with JobService.enqueue(tx, name, payload, { runAt?, dedupeKey? }); register handlers in src/custom/jobs.ts via CUSTOM_JOB_HANDLERS. Config: maxAttempts, pollIntervalMs, retentionDays, cron ([{name, schedule}] five-field UTC cron; exactly-once per occurrence via dedupe keys). Failed handlers retry with persisted exponential backoff; throw NonRetryableJobError to fail immediately.",

  examples: [
    { name: "Defaults", config: {} },
    {
      name: "Nightly cleanup",
      config: { cron: [{ name: "nightly-cleanup", schedule: "0 3 * * *" }] },
    },
  ],

  conformance: [
    {
      name: "jobs-default",
      description: "Job service, runner, handler contract and custom scaffold exist.",
      config: {},
      expectFiles: [
        "src/generated/jobs/job.service.ts",
        "src/generated/jobs/job.runner.ts",
        "src/generated/jobs/job-handler.ts",
        "src/generated/jobs/cron.ts",
        "src/custom/jobs.ts",
        "test/jobs.e2e-spec.ts",
      ],
      expectEndpoints: [],
    },
  ],
};
