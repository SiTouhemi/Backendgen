import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import { jobsConfig, type JobsConfig } from "./feature.js";

function file(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

function scaffold(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "custom-scaffold" };
}

const JOB_HANDLER = `/**
 * The contract between the generated job runner and your handlers. Handlers
 * are registered from CustomModule under CUSTOM_JOB_HANDLERS (see
 * src/custom/jobs.ts); nothing in src/generated/ needs to change to add one.
 */
export interface JobContext {
  name: string;
  /** Parsed JSON payload exactly as it was enqueued. */
  payload: unknown;
  /** 1-based attempt number. */
  attempt: number;
}

export type JobHandler = (context: JobContext) => Promise<void> | void;

/** Resolved handler map the runner consumes. */
export const JOB_HANDLERS = Symbol.for('backendgen:JobHandlers');

/** Provide this from CustomModule to register your handlers. */
export const CUSTOM_JOB_HANDLERS = Symbol.for('backendgen:CustomJobHandlers');

/**
 * Throw from a handler when retrying can never succeed (invalid payload,
 * permanent business rejection). The job is marked FAILED immediately.
 */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}
`;

const CRON = `/**
 * Minimal five-field cron matcher (minute hour day-of-month month day-of-week),
 * evaluated in UTC. Supports wildcards, steps (star-slash-n), values, a-b
 * ranges and comma lists — the exact grammar validated at generation time.
 */
function fieldMatches(field: string, value: number, minimum: number): boolean {
  if (field === '*') return true;

  const step = /^\\*\\/(\\d{1,3})$/.exec(field);
  if (step !== null) {
    return (value - minimum) % Number(step[1]) === 0;
  }

  return field.split(',').some((part) => {
    const range = /^(\\d{1,3})-(\\d{1,3})$/.exec(part);
    if (range !== null) {
      return value >= Number(range[1]) && value <= Number(range[2]);
    }
    return Number(part) === value;
  });
}

export function cronMatches(schedule: string, date: Date): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.trim().split(/\\s+/);
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return false;
  }

  const timeMatches =
    fieldMatches(minute, date.getUTCMinutes(), 0) &&
    fieldMatches(hour, date.getUTCHours(), 0) &&
    fieldMatches(month, date.getUTCMonth() + 1, 1);

  // Standard cron rule: when both day fields are restricted, either may match.
  const domRestricted = dayOfMonth !== '*';
  const dowRestricted = dayOfWeek !== '*';
  const domMatches = fieldMatches(dayOfMonth, date.getUTCDate(), 1);
  const dowMatches = fieldMatches(dayOfWeek, date.getUTCDay(), 0);
  const dayMatches =
    domRestricted && dowRestricted ? domMatches || dowMatches : domMatches && dowMatches;

  return timeMatches && dayMatches;
}

/** Stable key for the minute an occurrence belongs to; used for deduplication. */
export function cronOccurrenceKey(date: Date): string {
  const floored = new Date(date.getTime());
  floored.setUTCSeconds(0, 0);
  return floored.toISOString();
}
`;

const CRON_SPEC = `import { cronMatches, cronOccurrenceKey } from './cron';

describe('cron matcher', () => {
  const at = (iso: string): Date => new Date(iso);

  it('matches wildcards every minute', () => {
    expect(cronMatches('* * * * *', at('2030-01-01T10:15:00Z'))).toBe(true);
  });

  it('matches exact minute and hour', () => {
    expect(cronMatches('0 3 * * *', at('2030-01-01T03:00:00Z'))).toBe(true);
    expect(cronMatches('0 3 * * *', at('2030-01-01T03:01:00Z'))).toBe(false);
    expect(cronMatches('0 3 * * *', at('2030-01-01T04:00:00Z'))).toBe(false);
  });

  it('matches steps, ranges and lists', () => {
    expect(cronMatches('*/15 * * * *', at('2030-01-01T10:45:00Z'))).toBe(true);
    expect(cronMatches('*/15 * * * *', at('2030-01-01T10:20:00Z'))).toBe(false);
    expect(cronMatches('0 9-17 * * *', at('2030-01-01T13:00:00Z'))).toBe(true);
    expect(cronMatches('0 0 1,15 * *', at('2030-01-15T00:00:00Z'))).toBe(true);
    // Month/day fields are one-based, so */2 starts at January/day 1.
    expect(cronMatches('0 0 1 */2 *', at('2030-01-01T00:00:00Z'))).toBe(true);
    expect(cronMatches('0 0 1 */2 *', at('2030-02-01T00:00:00Z'))).toBe(false);
    expect(cronMatches('0 0 */2 * *', at('2030-01-03T00:00:00Z'))).toBe(true);
    expect(cronMatches('0 0 */2 * *', at('2030-01-02T00:00:00Z'))).toBe(false);
  });

  it('applies the either-day rule when both day fields are restricted', () => {
    // 2030-01-01 is a Tuesday (dow 2). dom=13 does not match, dow=2 does.
    expect(cronMatches('0 0 13 * 2', at('2030-01-01T00:00:00Z'))).toBe(true);
    expect(cronMatches('0 0 13 * 5', at('2030-01-01T00:00:00Z'))).toBe(false);
  });

  it('keys occurrences by their UTC minute', () => {
    expect(cronOccurrenceKey(at('2030-01-01T10:15:42.500Z'))).toBe('2030-01-01T10:15:00.000Z');
  });
});
`;

const JOB_SERVICE = `import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface EnqueueOptions {
  /** Earliest execution time. Defaults to now. */
  runAt?: Date;
  /** Two enqueues of the same (name, dedupeKey) yield exactly one job. */
  dedupeKey?: string;
}

type JobWriter = Pick<PrismaService, 'jobRecord'> | Prisma.TransactionClient;

const MAX_PAYLOAD_BYTES = 64 * 1024;
const JOB_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Enqueues durable jobs. Pass the surrounding transaction client to make the
 * job part of the caller's transaction: the job then exists if and only if the
 * domain change committed.
 */
@Injectable()
export class JobService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    client: JobWriter | null,
    name: string,
    payload: Record<string, unknown>,
    options: EnqueueOptions = {},
  ): Promise<void> {
    const writer = client ?? this.prisma;
    if (!JOB_NAME.test(name)) {
      throw new Error('Job name must be 1-64 lowercase letters, numbers, underscores, or hyphens');
    }
    if (options.dedupeKey !== undefined && options.dedupeKey.length > 256) {
      throw new Error('Job dedupeKey must not exceed 256 characters');
    }

    let serialized: string;
    try {
      const value = JSON.stringify(payload);
      if (value === undefined) throw new Error('not serializable');
      serialized = value;
    } catch {
      throw new Error('Job payload must be JSON serializable');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error('Job payload must not exceed 64 KiB');
    }

    try {
      await writer.jobRecord.create({
        data: {
          name,
          payload: serialized,
          nextAttemptAt: options.runAt ?? new Date(),
          ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
        },
      });
    } catch (error) {
      // A dedupe collision means the work is already queued: enqueue is
      // idempotent by design, so this is success, not failure.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        options.dedupeKey !== undefined
      ) {
        return;
      }
      throw error;
    }
  }
}
`;

function jobRunner(config: JobsConfig): string {
  const cronEntries = (config.cron ?? [])
    .map((entry) => `  { name: '${entry.name}', schedule: '${entry.schedule}' },`)
    .join("\n");

  return `import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  QUEUE_BATCH_SIZE,
  QUEUE_LEASE_MS,
  queueClaimSql,
  queueRetryDelayMs,
} from '../common/queue-runner';
import { PrismaService } from '../prisma/prisma.service';
import { cronMatches, cronOccurrenceKey } from './cron';
import {
  JOB_HANDLERS,
  JobHandler,
  NonRetryableJobError,
} from './job-handler';
import { JobService } from './job.service';

const MAX_ATTEMPTS = ${config.maxAttempts};
const POLL_INTERVAL_MS = ${config.pollIntervalMs};
const RETENTION_MS = ${config.retentionDays} * 24 * 60 * 60 * 1000;
const MAX_BATCHES_PER_TICK = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const CRON_TICK_MS = 30_000;

const CRON_JOBS: ReadonlyArray<{ name: string; schedule: string }> = [
${cronEntries}
];

interface ClaimedJob {
  id: string;
  name: string;
  payload: string | null;
  attempts: number;
  leaseUntil: Date;
}

/**
 * Executes durable jobs. Claims are short transactions using FOR UPDATE SKIP
 * LOCKED, so any number of instances run concurrently; execution happens after
 * the claim commits, under a lease. Delivery is at least once — a crash after a
 * handler succeeds but before DONE is recorded re-runs the handler, so handlers
 * should be idempotent.
 */
@Injectable()
export class JobRunner {
  private readonly logger = new Logger(JobRunner.name);

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobService,
    @Inject(JOB_HANDLERS) private readonly handlers: Map<string, JobHandler>,
  ) {}

  @Interval(POLL_INTERVAL_MS)
  async scheduledDispatch(): Promise<void> {
    try {
      await this.dispatchNow();
    } catch {
      // Never log payloads.
      this.logger.error('Job dispatch tick failed');
    }
  }

  @Interval(CRON_TICK_MS)
  async scheduledCronTick(): Promise<void> {
    try {
      await this.cronTickNow(new Date());
    } catch {
      this.logger.error('Cron tick failed');
    }
  }

  /**
   * Materializes one JobRecord per due cron occurrence. The dedupe key is the
   * occurrence minute, so however many instances (or ticks per minute) run,
   * exactly one job exists per occurrence.
   */
  async cronTickNow(at: Date): Promise<void> {
    for (const entry of CRON_JOBS) {
      if (!cronMatches(entry.schedule, at)) continue;
      await this.jobs.enqueue(null, entry.name, {}, {
        dedupeKey: 'cron:' + cronOccurrenceKey(at),
      });
    }
  }

  /** Drains a bounded number of batches; public so tests and operators can run on demand. */
  async dispatchNow(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      let total = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
        const count = await this.dispatchOnce();
        total += count;
        if (count < QUEUE_BATCH_SIZE) break;
      }

      await this.prisma.jobRecord.deleteMany({
        where: {
          status: { in: ['DONE', 'FAILED'] },
          updatedAt: { lt: new Date(Date.now() - RETENTION_MS) },
        },
      });

      return total;
    } finally {
      this.running = false;
    }
  }

  private async dispatchOnce(): Promise<number> {
    const rows = await this.claimBatch();
    await Promise.all(rows.map(async (row) => this.processJob(row)));
    return rows.length;
  }

  private async claimBatch(): Promise<ClaimedJob[]> {
    const leaseUntil = new Date(Date.now() + QUEUE_LEASE_MS);

    return this.prisma.$transaction(async (tx) => {
      // Retire exhausted work before selecting a batch. Otherwise a full page
      // of exhausted rows can hide runnable jobs behind it for an entire tick.
      await tx.jobRecord.updateMany({
        where: {
          status: 'PENDING',
          attempts: { gte: MAX_ATTEMPTS },
          nextAttemptAt: { lte: new Date() },
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        data: {
          status: 'FAILED',
          payload: null,
          lockedUntil: null,
          lastError: 'retry-limit-reached',
        },
      });

      const rows = await tx.$queryRaw<Array<Omit<ClaimedJob, 'leaseUntil'>>>(
        queueClaimSql('JobRecord', ['id', 'name', 'payload', 'attempts'], QUEUE_BATCH_SIZE),
      );

      if (rows.length === 0) return [];

      // The attempt is consumed when the lease is claimed, before any handler
      // side effect. If this process crashes, a later worker observes the
      // increment and the retry budget still converges.
      await tx.jobRecord.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: 'PENDING' },
        data: { lockedUntil: leaseUntil, attempts: { increment: 1 } },
      });

      return rows.map((row) => ({
        ...row,
        attempts: row.attempts + 1,
        leaseUntil,
      }));
    });
  }

  private async processJob(row: ClaimedJob): Promise<void> {
    const attempt = row.attempts;
    const handler = this.handlers.get(row.name);

    if (handler === undefined) {
      await this.settle(row, {
        status: 'FAILED',
        error: 'unsupported-job',
      });
      return;
    }

    let payload: unknown = null;
    try {
      payload = row.payload === null ? null : (JSON.parse(row.payload) as unknown);
    } catch {
      await this.settle(row, { status: 'FAILED', error: 'invalid-payload' });
      return;
    }

    try {
      await handler({ name: row.name, payload, attempt });
      await this.settle(row, { status: 'DONE', error: null });
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 256) : 'unknown-handler-error';

      if (error instanceof NonRetryableJobError || attempt >= MAX_ATTEMPTS) {
        await this.settle(row, { status: 'FAILED', error: message });
        return;
      }

      await this.prisma.jobRecord.updateMany({
        where: { id: row.id, status: 'PENDING', lockedUntil: row.leaseUntil },
        data: {
          nextAttemptAt: new Date(
            Date.now() + queueRetryDelayMs(attempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS),
          ),
          lockedUntil: null,
          lastError: message,
        },
      });
    }
  }

  private async settle(
    row: ClaimedJob,
    outcome: { status: 'DONE' | 'FAILED'; error: string | null },
  ): Promise<void> {
    await this.prisma.jobRecord.updateMany({
      where: { id: row.id, status: 'PENDING', lockedUntil: row.leaseUntil },
      data: {
        status: outcome.status,
        payload: null,
        lockedUntil: null,
        lastError: outcome.error,
      },
    });
  }
}
`;
}

const JOBS_MODULE = `import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CustomModule } from '../../custom/custom.module';
import {
  CUSTOM_JOB_HANDLERS,
  JOB_HANDLERS,
  JobHandler,
} from './job-handler';
import { JobRunner } from './job.runner';
import { JobService } from './job.service';

/**
 * Global so any module (generated or custom) can enqueue through JobService
 * without importing this module explicitly.
 */
@Global()
@Module({
  imports: [CustomModule, ScheduleModule.forRoot()],
  providers: [
    JobService,
    JobRunner,
    {
      provide: JOB_HANDLERS,
      useFactory: (custom?: Map<string, JobHandler>): Map<string, JobHandler> =>
        custom ?? new Map<string, JobHandler>(),
      inject: [{ token: CUSTOM_JOB_HANDLERS, optional: true }],
    },
  ],
  exports: [JobService, JOB_HANDLERS],
})
export class JobsModule {}
`;

const CUSTOM_SCAFFOLD = `import {
  JobContext,
  JobHandler,
} from '../generated/jobs/job-handler';

/**
 * Your job handlers. This file is written once and never regenerated.
 *
 * To activate them, provide the map from CustomModule:
 *
 *   import { CUSTOM_JOB_HANDLERS } from '../generated/jobs/job-handler';
 *   import { jobHandlers } from './jobs';
 *
 *   @Module({
 *     providers: [{ provide: CUSTOM_JOB_HANDLERS, useValue: jobHandlers }],
 *     exports: [CUSTOM_JOB_HANDLERS],
 *   })
 *   export class CustomModule {}
 *
 * Handlers should be idempotent: execution is at least once. Throw
 * NonRetryableJobError for permanent failures; any other error retries with
 * exponential backoff.
 */
export const jobHandlers = new Map<string, JobHandler>([
  [
    'heartbeat',
    (context: JobContext): void => {
      void context;
      // Replace with real work. Runs for the cron entry named 'heartbeat',
      // and for any JobService.enqueue(..., 'heartbeat', ...).
    },
  ],
]);
`;

function jobsE2e(context: TargetRenderContext): string {
  const prefix = context.settings.apiPrefix;
  const config = jobsConfig(context.config);
  void prefix;

  return `import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/generated/common/bootstrap';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import {
  JOB_HANDLERS,
  JobHandler,
  NonRetryableJobError,
} from '../src/generated/jobs/job-handler';
import { JobRunner } from '../src/generated/jobs/job.runner';
import { JobService } from '../src/generated/jobs/job.service';
import { resetDatabase } from './utils/reset';

describe('Background jobs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let runner: JobRunner;
  let jobs: JobService;

  const seen: Array<{ name: string; attempt: number; payload: unknown }> = [];
  let flakyRemainingFailures = 0;

  const handlers = new Map<string, JobHandler>([
    [
      'echo',
      (context): void => {
        seen.push({ name: context.name, attempt: context.attempt, payload: context.payload });
      },
    ],
    [
      'flaky',
      (context): void => {
        if (flakyRemainingFailures > 0) {
          flakyRemainingFailures -= 1;
          throw new Error('transient failure');
        }
        seen.push({ name: context.name, attempt: context.attempt, payload: context.payload });
      },
    ],
    [
      'poison',
      (): void => {
        throw new NonRetryableJobError('permanently invalid');
      },
    ],
    ['heartbeat', (): void => undefined],
  ]);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_HANDLERS)
      .useValue(handlers)
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    runner = app.get(JobRunner);
    jobs = app.get(JobService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    seen.length = 0;
    flakyRemainingFailures = 0;
  });

  it('enqueues transactionally: a rolled-back transaction leaves no job', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await jobs.enqueue(tx, 'echo', { value: 1 });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await prisma.jobRecord.count()).toBe(0);
  });

  it('deduplicates by (name, dedupeKey)', async () => {
    await jobs.enqueue(null, 'echo', { value: 1 }, { dedupeKey: 'once' });
    await jobs.enqueue(null, 'echo', { value: 2 }, { dedupeKey: 'once' });

    expect(await prisma.jobRecord.count({ where: { name: 'echo' } })).toBe(1);
  });

  it('runs a job to DONE and clears its payload', async () => {
    await jobs.enqueue(null, 'echo', { value: 42 });
    await runner.dispatchNow();

    expect(seen).toEqual([{ name: 'echo', attempt: 1, payload: { value: 42 } }]);

    const row = await prisma.jobRecord.findFirstOrThrow({ where: { name: 'echo' } });
    expect(row.status).toBe('DONE');
    expect(row.payload).toBeNull();
  });

  it('retries transient failures with backoff and succeeds', async () => {
    flakyRemainingFailures = 1;
    await jobs.enqueue(null, 'flaky', { value: 7 });

    await runner.dispatchNow();
    const pending = await prisma.jobRecord.findFirstOrThrow({ where: { name: 'flaky' } });
    expect(pending.status).toBe('PENDING');
    expect(pending.attempts).toBe(1);
    expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await prisma.jobRecord.update({
      where: { id: pending.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await runner.dispatchNow();

    const done = await prisma.jobRecord.findFirstOrThrow({ where: { name: 'flaky' } });
    expect(done.status).toBe('DONE');
    expect(done.attempts).toBe(2);
    expect(seen).toEqual([{ name: 'flaky', attempt: 2, payload: { value: 7 } }]);
  });

  it('fails immediately on NonRetryableJobError', async () => {
    await jobs.enqueue(null, 'poison', {});
    await runner.dispatchNow();

    const row = await prisma.jobRecord.findFirstOrThrow({ where: { name: 'poison' } });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('permanently invalid');
  });

  it('fails an unregistered job name without crashing the runner', async () => {
    await jobs.enqueue(null, 'nobody-home', {});
    await runner.dispatchNow();

    const row = await prisma.jobRecord.findFirstOrThrow({ where: { name: 'nobody-home' } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toBe('unsupported-job');
  });

  it('never invokes a handler after its retry budget was already consumed', async () => {
    await jobs.enqueue(null, 'echo', { value: 'must-not-run' });
    await prisma.jobRecord.updateMany({
      where: { name: 'echo' },
      data: { attempts: ${config.maxAttempts} },
    });

    await runner.dispatchNow();

    expect(seen).toEqual([]);
    const row = await prisma.jobRecord.findFirstOrThrow({ where: { name: 'echo' } });
    expect(row.status).toBe('FAILED');
    expect(row.payload).toBeNull();
    expect(row.lastError).toBe('retry-limit-reached');
  });

  it('removes retained DONE and FAILED rows', async () => {
    const old = new Date(Date.now() - ${config.retentionDays + 1} * 24 * 60 * 60_000);
    await prisma.jobRecord.createMany({
      data: [
        { name: 'echo', payload: null, status: 'DONE', nextAttemptAt: old },
        { name: 'poison', payload: null, status: 'FAILED', nextAttemptAt: old },
      ],
    });
    await prisma.jobRecord.updateMany({ data: { updatedAt: old } });

    await runner.dispatchNow();

    expect(await prisma.jobRecord.count()).toBe(0);
  });

  it('materializes exactly one job per cron occurrence across repeated ticks', async () => {
    const occurrence = new Date('2030-01-01T10:15:10Z');

    await runner.cronTickNow(occurrence);
    await runner.cronTickNow(new Date('2030-01-01T10:15:40Z'));

    expect(await prisma.jobRecord.count({ where: { name: 'heartbeat' } })).toBe(1);

    await runner.dispatchNow();
    const row = await prisma.jobRecord.findFirstOrThrow({ where: { name: 'heartbeat' } });
    expect(row.status).toBe('DONE');
  });
});
`;
}

export const jobsRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const config = jobsConfig(context.config);

    const files: RenderedFile[] = [
      file("src/generated/jobs/job-handler.ts", JOB_HANDLER),
      file("src/generated/jobs/cron.ts", CRON),
      file("src/generated/jobs/cron.spec.ts", CRON_SPEC),
      file("src/generated/jobs/job.service.ts", JOB_SERVICE),
      file("src/generated/jobs/job.runner.ts", jobRunner(config)),
      file("src/generated/jobs/jobs.module.ts", JOBS_MODULE),
      scaffold("src/custom/jobs.ts", CUSTOM_SCAFFOLD),
      file("test/jobs.e2e-spec.ts", jobsE2e(context)),
    ];

    return {
      ...emptyRenderResult(),
      files,
      rootModules: [
        {
          symbol: "JobsModule",
          from: "./generated/jobs/jobs.module",
          kind: "module",
          order: 50,
        },
      ],
      packageDependencies: { "@nestjs/schedule": "5.0.1" },
    };
  },
};
