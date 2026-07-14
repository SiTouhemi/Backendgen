import { names } from "@backend-compiler/target-nestjs-prisma";
import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import {
  effectiveEvents,
  EVENT_MAP,
  notificationsConfig,
  outboxEvents,
  RECOVERY_EVENT_KEYS,
  type AuthRecoveryConfig,
  type NotificationsConfig,
} from "./feature.js";

function file(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

const PROVIDER_INTERFACE = `export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface DeliveryResult {
  providerId: string;
  messageId: string | null;
}

/** Provider failure classification used to avoid retrying permanent 4xx errors. */
export class NotificationDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'NotificationDeliveryError';
  }
}

/**
 * The only thing the domain knows about delivery. Services emit events; nothing
 * in src/generated/reservations or src/generated/auth imports a concrete
 * provider, so swapping transports never touches domain code.
 */
export interface NotificationProvider {
  readonly id: string;
  send(message: NotificationMessage): Promise<DeliveryResult>;
}

export const NOTIFICATION_PROVIDER = Symbol.for('backendgen:NotificationProvider');

/** Token CustomModule can provide to deliver through your own transport. */
export const CUSTOM_NOTIFICATION_PROVIDER = Symbol.for('backendgen:CustomNotificationProvider');
`;

const LOG_PROVIDER = `import { Injectable, Logger } from '@nestjs/common';
import {
  DeliveryResult,
  NotificationMessage,
  NotificationProvider,
} from '../notification-provider';

/** Development provider: records metadata only and never logs recipient data or message bodies. */
@Injectable()
export class LogNotificationProvider implements NotificationProvider {
  readonly id = 'log';

  private readonly logger = new Logger(LogNotificationProvider.name);

  async send(_message: NotificationMessage): Promise<DeliveryResult> {
    this.logger.log('[notification] accepted');

    return { providerId: this.id, messageId: null };
  }
}
`;

const MOCK_PROVIDER = `import { Injectable } from '@nestjs/common';
import {
  DeliveryResult,
  NotificationMessage,
  NotificationProvider,
} from '../notification-provider';

/**
 * Test provider: records every message instead of sending it. Select it with
 * NOTIFICATIONS_PROVIDER=mock, or provide it directly in a testing module.
 */
@Injectable()
export class MockNotificationProvider implements NotificationProvider {
  readonly id = 'mock';

  readonly sent: NotificationMessage[] = [];

  /** Set to make the next send fail, so retry behaviour can be exercised. */
  failures = 0;

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('Simulated delivery failure');
    }

    this.sent.push(message);
    return { providerId: this.id, messageId: \`mock-\${this.sent.length}\` };
  }

  reset(): void {
    this.sent.length = 0;
    this.failures = 0;
  }
}
`;

const RESEND_PROVIDER = `import { Injectable } from '@nestjs/common';
import {
  DeliveryResult,
  NotificationDeliveryError,
  NotificationMessage,
  NotificationProvider,
} from '../notification-provider';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

interface ResendResponse {
  id?: string;
}

/**
 * Resend adapter over the documented HTTP API, using the runtime's own fetch so
 * that no additional dependency is pulled into the generated project.
 *
 * It refuses to construct without RESEND_API_KEY: a misconfigured deployment
 * fails at start-up rather than silently dropping mail.
 */
@Injectable()
export class ResendNotificationProvider implements NotificationProvider {
  readonly id = 'resend';

  private readonly apiKey: string;

  private readonly from: string;

  constructor(from: string, apiKey: string | undefined = process.env.RESEND_API_KEY) {
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new Error(
        'RESEND_API_KEY is required when NOTIFICATIONS_PROVIDER is "resend". See .env.example.',
      );
    }

    this.apiKey = apiKey;
    this.from = from;
  }

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: \`Bearer \${this.apiKey}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      await response.body?.cancel();
      const retryable = response.status === 429 || response.status >= 500;
      throw new NotificationDeliveryError(
        \`Resend rejected the message with status \${response.status}\`,
        retryable,
      );
    }

    const payload = (await response.json()) as ResendResponse;
    return { providerId: this.id, messageId: typeof payload.id === 'string' ? payload.id : null };
  }
}
`;

const RECOVERY_LINKS = `export const RECOVERY_PUBLIC_URL = Symbol.for(
  'backendgen:RecoveryPublicUrl',
);

/**
 * APP_PUBLIC_URL is an origin, not an arbitrary redirect target. Restricting it
 * to an HTTP(S) origin prevents credentials, query parameters and fragments
 * from being accidentally copied into single-use recovery links.
 */
export function requirePublicAppUrl(
  raw: string | undefined = process.env.APP_PUBLIC_URL,
  nodeEnvironment: string | undefined = process.env.NODE_ENV,
): URL {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('APP_PUBLIC_URL is required when account recovery is enabled');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('APP_PUBLIC_URL must be a valid absolute HTTP(S) origin');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'APP_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query, or fragment',
    );
  }

  if (nodeEnvironment === 'production' && url.protocol !== 'https:') {
    throw new Error('APP_PUBLIC_URL must use HTTPS when NODE_ENV is production');
  }

  return url;
}

export function recoveryLink(base: URL, path: 'verify-email' | 'reset-password', token: string): string {
  const url = new URL(\`/\${path}\`, base);
  url.searchParams.set('token', token);
  return url.toString();
}
`;

const RECOVERY_LINKS_SPEC = `import { recoveryLink, requirePublicAppUrl } from './recovery-links';

describe('recovery links', () => {
  it('allows HTTP for local development and preserves an HTTPS production origin', () => {
    expect(requirePublicAppUrl('http://localhost:3000', 'development').origin).toBe(
      'http://localhost:3000',
    );
    expect(requirePublicAppUrl('https://app.example.test', 'production').origin).toBe(
      'https://app.example.test',
    );
  });

  it('rejects plaintext recovery links in production', () => {
    expect(() => requirePublicAppUrl('http://app.example.test', 'production')).toThrow(
      /must use HTTPS/,
    );
  });

  it('rejects credentials, paths, queries and fragments in the configured origin', () => {
    expect(() => requirePublicAppUrl('https://app.example.test/a?b=c#d', 'test')).toThrow(
      /without credentials, path, query, or fragment/,
    );
  });

  it('encodes the single-use credential in the recovery link', () => {
    expect(
      recoveryLink(new URL('https://app.example.test'), 'reset-password', 'token+/='),
    ).toBe('https://app.example.test/reset-password?token=token%2B%2F%3D');
  });
});
`;

function templatesFile(config: NotificationsConfig): string {
  const templates: string[] = [];

  if (config.events.includes("user_registered")) {
    templates.push(`export function userRegistered(email: string): NotificationMessage {
  return {
    to: email,
    subject: 'Welcome',
    text: \`Your account (\${email}) is ready.\`,
    html: \`<p>Your account (<strong>\${escapeHtml(email)}</strong>) is ready.</p>\`,
  };
}`);
  }

  if (config.events.includes("user_email_verification_requested")) {
    templates.push(`export function emailVerification(
  email: string,
  token: string,
  publicAppUrl: URL,
): NotificationMessage {
  const link = recoveryLink(publicAppUrl, 'verify-email', token);
  return {
    to: email,
    subject: 'Verify your email address',
    text: \`Verify your email address: \${link}\`,
    html: \`<p><a href="\${escapeHtml(link)}">Verify your email address</a></p>\`,
  };
}`);
  }

  if (config.events.includes("user_password_reset_requested")) {
    templates.push(`export function passwordReset(
  email: string,
  token: string,
  publicAppUrl: URL,
): NotificationMessage {
  const link = recoveryLink(publicAppUrl, 'reset-password', token);
  return {
    to: email,
    subject: 'Reset your password',
    text: \`Reset your password within one hour: \${link}\`,
    html: \`<p><a href="\${escapeHtml(link)}">Reset your password</a>. This link expires in one hour.</p>\`,
  };
}`);
  }

  const reservationTemplates: Array<[string, string, string]> = [
    ["reservation_created", "reservationCreated", "Your reservation is being held"],
    ["reservation_confirmed", "reservationConfirmed", "Your reservation is confirmed"],
    ["reservation_cancelled", "reservationCancelled", "Your reservation was cancelled"],
    ["reservation_expired", "reservationExpired", "Your reservation hold expired"],
  ];

  for (const [event, fn, subject] of reservationTemplates) {
    if (!config.events.includes(event)) continue;

    templates.push(`export function ${fn}(email: string, reservationId: string): NotificationMessage {
  return {
    to: email,
    subject: '${subject}',
    text: \`Reservation \${reservationId}: ${subject.toLowerCase()}.\`,
    html: \`<p>Reservation <code>\${escapeHtml(reservationId)}</code>: ${subject.toLowerCase()}.</p>\`,
  };
}`);
  }

  const hasRecovery = (RECOVERY_EVENT_KEYS as readonly string[]).some((event) =>
    config.events.includes(event),
  );

  return `import { NotificationMessage } from './notification-provider';
${hasRecovery ? "import { recoveryLink } from './recovery-links';\n" : ""}

/** Values interpolated into HTML are escaped; they come from user-controlled data. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

${templates.join("\n\n")}
`;
}

function serviceFile(config: NotificationsConfig): string {
  return `import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DeliveryResult,
  NOTIFICATION_PROVIDER,
  NotificationDeliveryError,
  NotificationMessage,
  NotificationProvider,
} from './notification-provider';

const MAX_ATTEMPTS = ${config.maxAttempts};
const BASE_BACKOFF_MS = 250;
const PROVIDER_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Inline delivery with bounded exponential backoff. It is reserved for account
 * recovery credentials that must not be persisted. Durable outbox dispatch uses
 * deliverOnce(), because its backoff and attempt count live in PostgreSQL.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(NOTIFICATION_PROVIDER) private readonly provider: NotificationProvider,
  ) {}

  async deliverOnce(message: NotificationMessage): Promise<DeliveryResult> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.provider.send(message),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new NotificationDeliveryError('Notification provider timed out', true));
          }, PROVIDER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  async send(message: NotificationMessage): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.deliverOnce(message);
        return true;
      } catch (error) {
        const retryable = !(error instanceof NotificationDeliveryError) || error.retryable;

        if (!retryable || attempt === MAX_ATTEMPTS) {
          this.logger.error(
            \`Notification delivery failed via \${this.provider.id} after \${attempt} attempt(s)\`,
          );
          return false;
        }

        this.logger.warn(
          \`Notification delivery attempt \${attempt} failed via \${this.provider.id}; retrying\`,
        );
        await delay(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }

    return false;
  }
}
`;
}

function listenerFile(config: NotificationsConfig): string {
  const handlers: string[] = [];
  const templateImports = new Set<string>();

  if (config.events.includes("user_email_verification_requested")) {
    templateImports.add("emailVerification");
    handlers.push(`  @OnEvent('user.email_verification_requested', { suppressErrors: false })
  async onEmailVerificationRequested(payload: {
    email: string;
    token: string;
  }): Promise<void> {
    const delivered = await this.notifications.send(
      emailVerification(payload.email, payload.token, this.publicAppUrl),
    );

    if (!delivered) {
      throw new Error('Email verification notification could not be delivered');
    }
  }`);
  }

  if (config.events.includes("user_password_reset_requested")) {
    templateImports.add("passwordReset");
    handlers.push(`  @OnEvent('user.password_reset_requested', { suppressErrors: false })
  async onPasswordResetRequested(payload: { email: string; token: string }): Promise<void> {
    const delivered = await this.notifications.send(
      passwordReset(payload.email, payload.token, this.publicAppUrl),
    );

    if (!delivered) {
      throw new Error('Password reset notification could not be delivered');
    }
  }`);
  }

  return `import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RECOVERY_PUBLIC_URL } from './recovery-links';
import { NotificationService } from './notification.service';
import { ${[...templateImports].sort().join(", ")} } from './templates';

/**
 * Recovery credentials are the deliberate exception to durable dispatch: raw
 * tokens never enter NotificationOutbox. Publishers must use
 * await events.emitAsync(...); using emit() would not await these retries.
 */
@Injectable()
export class NotificationListener {
  constructor(
    private readonly notifications: NotificationService,
    @Inject(RECOVERY_PUBLIC_URL) private readonly publicAppUrl: URL,
  ) {}

${handlers.join("\n\n")}
}
`;
}

function outboxFile(durableEvents: readonly string[]): string {
  const durableEventNames = durableEvents.map((event) => EVENT_MAP[event]).filter(Boolean);
  const recoveryEventNames = RECOVERY_EVENT_KEYS.map((event) => EVENT_MAP[event]);

  return `import type { Prisma } from '@prisma/client';

export const DURABLE_NOTIFICATION_EVENTS = new Set<string>(${JSON.stringify(durableEventNames)});
const RECOVERY_NOTIFICATION_EVENTS = new Set<string>(${JSON.stringify(recoveryEventNames)});

/**
 * Adds a subscribed notification to the caller's existing transaction. Domain
 * state and its notification therefore commit or roll back together.
 *
 * Recovery events deliberately no-op here: their payload contains a raw
 * single-use credential and must be delivered with awaited emitAsync instead of
 * being persisted. Other unsubscribed events also no-op, allowing domain
 * renderers to use this stable integration contract.
 */
export async function enqueueNotification(
  tx: Prisma.TransactionClient,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (RECOVERY_NOTIFICATION_EVENTS.has(eventName) || !DURABLE_NOTIFICATION_EVENTS.has(eventName)) {
    return;
  }

  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error('Notification payload must be JSON serializable');
  }

  await tx.notificationOutbox.create({
    data: {
      eventName,
      payload: serialized,
      nextAttemptAt: new Date(),
    },
  });
}
`;
}

function dispatcherFile(
  config: NotificationsConfig,
  durableEvents: readonly string[],
  userEntity: string,
  userSoftDelete: boolean,
): string {
  const delegate = names.delegate(userEntity);
  const recipientLookup = userSoftDelete
    ? `findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true },
    })`
    : `findUnique({
      where: { id: userId },
      select: { email: true },
    })`;
  const templates = new Set<string>();
  const cases: string[] = [];

  if (durableEvents.includes("user_registered")) {
    templates.add("userRegistered");
    cases.push(`      case 'user.registered': {
        const email = await this.recipientEmail(requiredString(payload, 'userId'));
        return userRegistered(email);
      }`);
  }

  const reservationEvents: Array<[string, string, string]> = [
    ["reservation_created", "reservation.created", "reservationCreated"],
    ["reservation_confirmed", "reservation.confirmed", "reservationConfirmed"],
    ["reservation_cancelled", "reservation.cancelled", "reservationCancelled"],
    ["reservation_expired", "reservation.expired", "reservationExpired"],
  ];

  for (const [key, eventName, template] of reservationEvents) {
    if (!durableEvents.includes(key)) continue;
    templates.add(template);
    cases.push(`      case '${eventName}': {
        const email = await this.recipientEmail(requiredString(payload, 'ownerId'));
        return ${template}(email, requiredString(payload, 'reservationId'));
      }`);
  }

  return `import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationDeliveryError,
  NotificationMessage,
} from './notification-provider';
import { NotificationService } from './notification.service';
import { ${[...templates].sort().join(", ")} } from './templates';

const MAX_ATTEMPTS = ${config.maxAttempts};
const BATCH_SIZE = 10;
const MAX_BATCHES_PER_TICK = 10;
const LEASE_MS = 2 * 60_000;
const DISPATCH_INTERVAL_MS = 5_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;

interface RawClaimedRow {
  id: string;
  eventName: string;
  payload: string | null;
  attempts: number;
}

interface ClaimedRow extends RawClaimedRow {
  leaseUntil: Date;
}

class DispatchFailure extends Error {
  constructor(
    readonly category: string,
    readonly retryable: boolean,
  ) {
    super(category);
    this.name = 'DispatchFailure';
  }
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new DispatchFailure('invalid-payload', false);
  }
  return value;
}

function parsePayload(value: string | null): Record<string, unknown> {
  if (value === null) {
    throw new DispatchFailure('invalid-payload', false);
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DispatchFailure('invalid-payload', false);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DispatchFailure) throw error;
    throw new DispatchFailure('invalid-payload', false);
  }
}

function retryDelay(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

/**
 * PostgreSQL transactional-outbox dispatcher.
 *
 * Claims are short transactions using FOR UPDATE SKIP LOCKED, so any number of
 * replicas may run concurrently. Provider calls happen after commit and carry a
 * lease. A crash after the provider accepts a message but before DELIVERED is
 * recorded can cause a duplicate: delivery is intentionally at least once.
 */
@Injectable()
export class NotificationOutboxDispatcher {
  private readonly logger = new Logger(NotificationOutboxDispatcher.name);

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Interval(DISPATCH_INTERVAL_MS)
  async scheduledDispatch(): Promise<void> {
    try {
      await this.dispatchPending();
    } catch {
      // Never log payloads or provider error text.
      this.logger.error('Notification outbox dispatch tick failed');
    }
  }

  /** Drains a bounded number of batches, preventing one tick from monopolising the process. */
  async dispatchPending(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      let total = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
        const count = await this.dispatchOnce();
        total += count;
        if (count < BATCH_SIZE) break;
      }
      return total;
    } finally {
      this.running = false;
    }
  }

  /** Claims and processes one batch. Public so integration tests and operators can drain on demand. */
  async dispatchOnce(): Promise<number> {
    const rows = await this.claimBatch();
    await Promise.all(rows.map(async (row) => this.processRow(row)));
    return rows.length;
  }

  private async claimBatch(): Promise<ClaimedRow[]> {
    const leaseUntil = new Date(Date.now() + LEASE_MS);

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RawClaimedRow[]>(Prisma.sql\`
        SELECT "id", "eventName", "payload", "attempts"
        FROM "NotificationOutbox"
        WHERE "status" = 'PENDING'
          AND "nextAttemptAt" <= NOW()
          AND ("lockedUntil" IS NULL OR "lockedUntil" <= NOW())
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT \${BATCH_SIZE}
      \`);

      if (rows.length === 0) return [];

      await tx.notificationOutbox.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: 'PENDING' },
        data: { lockedUntil: leaseUntil },
      });

      return rows.map((row) => ({ ...row, leaseUntil }));
    });
  }

  private async processRow(row: ClaimedRow): Promise<void> {
    try {
      const message = await this.renderMessage(row.eventName, parsePayload(row.payload));
      const result = await this.notifications.deliverOnce(message);
      await this.prisma.notificationOutbox.updateMany({
        where: { id: row.id, status: 'PENDING', lockedUntil: row.leaseUntil },
        data: {
          status: 'DELIVERED',
          attempts: row.attempts + 1,
          deliveredAt: new Date(),
          providerMessageId: result.messageId?.slice(0, 256) ?? null,
          payload: null,
          lockedUntil: null,
          lastError: null,
        },
      });
    } catch (error) {
      await this.recordFailure(row, error);
    }
  }

  private async recordFailure(row: ClaimedRow, error: unknown): Promise<void> {
    const attempt = row.attempts + 1;
    const classified = this.classify(error);
    const terminal = !classified.retryable || attempt >= MAX_ATTEMPTS;
    const category = terminal && classified.retryable ? 'retry-limit-reached' : classified.category;

    await this.prisma.notificationOutbox.updateMany({
      where: { id: row.id, status: 'PENDING', lockedUntil: row.leaseUntil },
      data: terminal
        ? {
            status: 'FAILED',
            attempts: attempt,
            payload: null,
            lockedUntil: null,
            lastError: category,
          }
        : {
            attempts: attempt,
            nextAttemptAt: new Date(Date.now() + retryDelay(attempt)),
            lockedUntil: null,
            lastError: category,
          },
    });
  }

  private classify(error: unknown): { category: string; retryable: boolean } {
    if (error instanceof DispatchFailure) {
      return { category: error.category, retryable: error.retryable };
    }
    if (error instanceof NotificationDeliveryError) {
      return {
        category: error.retryable ? 'retryable-provider-error' : 'permanent-provider-error',
        retryable: error.retryable,
      };
    }
    return { category: 'retryable-delivery-error', retryable: true };
  }

  private async renderMessage(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<NotificationMessage> {
    switch (eventName) {
${cases.join("\n")}
      default:
        throw new DispatchFailure('unsupported-event', false);
    }
  }

  private async recipientEmail(userId: string): Promise<string> {
    const account = await this.prisma.${delegate}.${recipientLookup};

    if (account === null) {
      throw new DispatchFailure('recipient-not-found', false);
    }
    return account.email;
  }
}
`;
}

function moduleFile(
  config: NotificationsConfig,
  hasRecoveryEvents: boolean,
  hasDurableEvents: boolean,
): string {
  return `import { Module } from '@nestjs/common';
${hasDurableEvents ? "import { ScheduleModule } from '@nestjs/schedule';\n" : ""}import { CustomModule } from '../../custom/custom.module';
${hasDurableEvents ? "import { NotificationOutboxDispatcher } from './notification.dispatcher';\n" : ""}${hasRecoveryEvents ? "import { NotificationListener } from './notification.listener';\n" : ""}import {
  CUSTOM_NOTIFICATION_PROVIDER,
  NOTIFICATION_PROVIDER,
  NotificationProvider,
} from './notification-provider';
${
  hasRecoveryEvents
    ? "import { RECOVERY_PUBLIC_URL, requirePublicAppUrl } from './recovery-links';\n"
    : ""
}import { NotificationService } from './notification.service';
import { LogNotificationProvider } from './providers/log.provider';
import { MockNotificationProvider } from './providers/mock.provider';
import { ResendNotificationProvider } from './providers/resend.provider';

const DEFAULT_PROVIDER = '${config.provider}';
const DEFAULT_FROM = ${JSON.stringify(config.from)};
const RECOVERY_DELIVERY_REQUIRED = ${String(hasRecoveryEvents)};

/**
 * Under test, delivery defaults to the mock provider. A test run must never be
 * able to reach a real transport, and it must never need a real API key to boot.
 * An explicit NOTIFICATIONS_PROVIDER still wins.
 */
function selectedProviderId(): string {
  const explicit = process.env.NOTIFICATIONS_PROVIDER;
  const selected = explicit !== undefined && explicit !== ''
    ? explicit
    : process.env.NODE_ENV === 'test'
      ? 'mock'
      : DEFAULT_PROVIDER;

  if (selected === 'mock' && process.env.NODE_ENV !== 'test') {
    throw new Error('The mock notification provider is only allowed when NODE_ENV is "test".');
  }

  if (selected === 'log' && RECOVERY_DELIVERY_REQUIRED) {
    throw new Error(
      'The log notification provider cannot deliver account-recovery links. Use resend or custom.',
    );
  }

  return selected;
}

/**
 * Selects one provider at start-up. Only the selected provider is constructed,
 * so a project configured for logging never needs a Resend key.
 */
function selectProvider(custom?: NotificationProvider): NotificationProvider {
  const selected = selectedProviderId();

  // The mock is the hermetic test transport. Under test it wins even over a
  // registered custom provider, so generated integration tests always capture
  // messages instead of handing credentials to project-specific code.
  if (selected === 'mock') {
    return new MockNotificationProvider();
  }

  if (custom !== undefined) {
    return custom;
  }

  const from = process.env.NOTIFICATIONS_FROM ?? DEFAULT_FROM;

  switch (selected) {
    case 'resend':
      return new ResendNotificationProvider(from);
    case 'log':
      return new LogNotificationProvider();
    case 'custom':
      throw new Error(
        'NOTIFICATIONS_PROVIDER is "custom", but CustomModule did not export CUSTOM_NOTIFICATION_PROVIDER.',
      );
    default:
      throw new Error(
        \`Unknown NOTIFICATIONS_PROVIDER "\${selected}". Use one of: log, resend, custom, mock.\`,
      );
  }
}

@Module({
  imports: [CustomModule${hasDurableEvents ? ", ScheduleModule.forRoot()" : ""}],
  providers: [
    NotificationService,
${hasRecoveryEvents ? "    NotificationListener,\n    { provide: RECOVERY_PUBLIC_URL, useFactory: requirePublicAppUrl },\n" : ""}${hasDurableEvents ? "    NotificationOutboxDispatcher,\n" : ""}    {
      provide: NOTIFICATION_PROVIDER,
      useFactory: selectProvider,
      inject: [{ token: CUSTOM_NOTIFICATION_PROVIDER, optional: true }],
    },
  ],
  exports: [NotificationService, NOTIFICATION_PROVIDER${hasDurableEvents ? ", NotificationOutboxDispatcher" : ""}],
})
export class NotificationModule {}
`;
}

const SERVICE_SPEC = `import { Test } from '@nestjs/testing';
import { NOTIFICATION_PROVIDER } from './notification-provider';
import { NotificationService } from './notification.service';
import { MockNotificationProvider } from './providers/mock.provider';

describe('NotificationService', () => {
  let provider: MockNotificationProvider;
  let service: NotificationService;

  beforeEach(async () => {
    provider = new MockNotificationProvider();

    const moduleRef = await Test.createTestingModule({
      providers: [NotificationService, { provide: NOTIFICATION_PROVIDER, useValue: provider }],
    }).compile();

    service = moduleRef.get(NotificationService);
  });

  const message = {
    to: 'someone@example.test',
    subject: 'Subject',
    text: 'Body',
    html: '<p>Body</p>',
  };

  it('delivers through the configured provider', async () => {
    await expect(service.send(message)).resolves.toBe(true);
    expect(provider.sent).toHaveLength(1);
  });

  it('retries a transient failure and eventually delivers', async () => {
    provider.failures = 1;

    await expect(service.send(message)).resolves.toBe(true);
    expect(provider.sent).toHaveLength(1);
  });

  it('gives up after the configured number of attempts instead of throwing', async () => {
    provider.failures = 99;

    // A delivery failure must not propagate into the domain operation that
    // triggered it.
    await expect(service.send(message)).resolves.toBe(false);
    expect(provider.sent).toHaveLength(0);
  });
});
`;

function recoveryListenerSpec(config: NotificationsConfig): string {
  const tests: string[] = [];
  const firstMethod = config.events.includes("user_email_verification_requested")
    ? "onEmailVerificationRequested"
    : "onPasswordResetRequested";

  if (config.events.includes("user_email_verification_requested")) {
    tests.push(`  it('awaits delivery and builds a validated email-verification link', async () => {
    await listener.onEmailVerificationRequested({
      email: 'person@example.test',
      token: 'verify+/=',
    });

    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'person@example.test',
        text: expect.stringContaining('https://app.example.test/verify-email?token=verify%2B%2F%3D'),
      }),
    );
  });`);
  }

  if (config.events.includes("user_password_reset_requested")) {
    tests.push(`  it('awaits delivery and builds a validated password-reset link', async () => {
    await listener.onPasswordResetRequested({
      email: 'person@example.test',
      token: 'reset-token',
    });

    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'person@example.test',
        text: expect.stringContaining('https://app.example.test/reset-password?token=reset-token'),
      }),
    );
  });`);
  }

  return `import { NotificationListener } from './notification.listener';

describe('NotificationListener recovery delivery', () => {
  const notifications = { send: jest.fn() };
  const listener = new NotificationListener(
    notifications as never,
    new URL('https://app.example.test'),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    notifications.send.mockResolvedValue(true);
  });

${tests.join("\n\n")}

  it('rejects when bounded inline delivery is exhausted', async () => {
    notifications.send.mockResolvedValue(false);

    await expect(
      listener.${firstMethod}({ email: 'person@example.test', token: 'secret-token' }),
    ).rejects.toThrow(/could not be delivered/);
  });
});
`;
}

function outboxSpec(durableEvents: readonly string[]): string {
  const durableEventName = EVENT_MAP[durableEvents[0] as string] as string;

  return `import { enqueueNotification } from './outbox';

describe('enqueueNotification', () => {
  const create = jest.fn();
  const tx = { notificationOutbox: { create } };

  beforeEach(() => {
    jest.clearAllMocks();
    create.mockResolvedValue({ id: 'outbox-1' });
  });

  it('writes subscribed durable events through the caller transaction', async () => {
    await enqueueNotification(tx as never, '${durableEventName}', { userId: 'user-1' });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventName: '${durableEventName}',
        payload: JSON.stringify({ userId: 'user-1' }),
      }),
    });
  });

  it('never persists credential-bearing recovery events', async () => {
    await enqueueNotification(tx as never, 'user.password_reset_requested', {
      userId: 'user-1',
      token: 'raw-secret-token',
    });

    expect(create).not.toHaveBeenCalled();
  });
});
`;
}

function dispatcherSpec(
  config: NotificationsConfig,
  durableEvents: readonly string[],
  userEntity: string,
  userSoftDelete: boolean,
): string {
  const delegate = names.delegate(userEntity);
  const recipientLookup = userSoftDelete ? "findFirst" : "findUnique";
  const event = durableEvents[0] as string;
  const eventName = EVENT_MAP[event] as string;
  const payload = event === "user_registered"
    ? { userId: "user-1" }
    : { ownerId: "user-1", reservationId: "reservation-1" };

  return `import { NotificationOutboxDispatcher } from './notification.dispatcher';

describe('NotificationOutboxDispatcher', () => {
  const tx = {
    $queryRaw: jest.fn(),
    notificationOutbox: { updateMany: jest.fn() },
  };
  const outbox = { updateMany: jest.fn() };
  const accounts = { findFirst: jest.fn(), findUnique: jest.fn() };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    notificationOutbox: outbox,
    ${delegate}: accounts,
  };
  const notifications = { deliverOnce: jest.fn() };
  const dispatcher = new NotificationOutboxDispatcher(prisma as never, notifications as never);

  function row(attempts = 0) {
    return {
      id: 'outbox-1',
      eventName: '${eventName}',
      payload: ${JSON.stringify(JSON.stringify(payload))},
      attempts,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([row()]);
    tx.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
    outbox.updateMany.mockResolvedValue({ count: 1 });
    accounts.${recipientLookup}.mockResolvedValue({ email: 'person@example.test' });
    notifications.deliverOnce.mockResolvedValue({ providerId: 'mock', messageId: 'message-1' });
  });

  it('marks a claimed row delivered and clears its payload', async () => {
    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    expect(outbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DELIVERED',
          attempts: 1,
          payload: null,
          providerMessageId: 'message-1',
        }),
      }),
    );
  });
${
  userSoftDelete
    ? `
  it('excludes soft-deleted recipient accounts', async () => {
    accounts.findFirst.mockResolvedValue(null);

    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    expect(accounts.findFirst).toHaveBeenCalledWith({
      where: { id: 'user-1', deletedAt: null },
      select: { email: true },
    });
    expect(notifications.deliverOnce).not.toHaveBeenCalled();
    expect(outbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          payload: null,
          lastError: 'recipient-not-found',
        }),
      }),
    );
  });
`
    : ""
}

  it('persists a non-sensitive retry schedule after a transient failure', async () => {
    notifications.deliverOnce.mockRejectedValue(new Error('provider response contained a secret'));

    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    expect(outbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attempts: 1,
          lastError: 'retryable-delivery-error',
          lockedUntil: null,
        }),
      }),
    );
    expect(JSON.stringify(outbox.updateMany.mock.calls)).not.toContain('provider response contained a secret');
  });

  it('moves an exhausted row to FAILED and destroys its payload', async () => {
    tx.$queryRaw.mockResolvedValue([row(${config.maxAttempts - 1})]);
    notifications.deliverOnce.mockRejectedValue(new Error('still unavailable'));

    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    expect(outbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          attempts: ${config.maxAttempts},
          payload: null,
          lastError: 'retry-limit-reached',
        }),
      }),
    );
  });
});
`;
}

function outboxE2e(
  durableEvents: readonly string[],
  userEntity: string,
  userSoftDelete: boolean,
): string {
  const event = durableEvents[0] as string;
  const eventName = EVENT_MAP[event] as string;
  const model = names.model(userEntity);
  const factory = `create${model}`;
  const expectedSubject: Readonly<Record<string, string>> = {
    user_registered: "Welcome",
    reservation_created: "Your reservation is being held",
    reservation_confirmed: "Your reservation is confirmed",
    reservation_cancelled: "Your reservation was cancelled",
    reservation_expired: "Your reservation hold expired",
  };
  const subject = expectedSubject[event];
  if (subject === undefined) {
    throw new Error(`No integration-test expectation exists for durable event '${event}'`);
  }

  const payload = event === "user_registered"
    ? `{ userId }`
    : `{ ownerId: userId, reservationId: 'reservation-e2e' }`;
  const expectedContent = event === "user_registered" ? "email" : "'reservation-e2e'";
  const softDeleteTest = userSoftDelete
    ? `
  it('terminally fails without delivery when the recipient was soft deleted', async () => {
    const email = 'deleted-outbox-recipient@example.test';
    const account = await ${factory}(prisma, { email, deletedAt: new Date() });
    const row = await enqueueFor(account.id);

    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    expect(provider.sent).toEqual([]);
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 1,
      payload: null,
      lastError: 'recipient-not-found',
    });
  });
`
    : "";

  return `import { NotificationOutboxDispatcher } from '../src/generated/notifications/notification.dispatcher';
import { NotificationService } from '../src/generated/notifications/notification.service';
import { enqueueNotification } from '../src/generated/notifications/outbox';
import { MockNotificationProvider } from '../src/generated/notifications/providers/mock.provider';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { ${factory} } from './utils/factories';
import { resetDatabase } from './utils/reset';

describe('notification outbox (e2e)', () => {
  const prisma = new PrismaService();
  const provider = new MockNotificationProvider();
  const notifications = new NotificationService(provider);
  const dispatcher = new NotificationOutboxDispatcher(prisma, notifications);

  beforeAll(async () => {
    // Construct the dispatcher directly: this keeps the scheduled interval out
    // of the test while retaining the real Prisma/PostgreSQL implementation.
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    provider.reset();
  });

  async function enqueueFor(userId: string) {
    await prisma.$transaction(async (tx) => {
      await enqueueNotification(tx, '${eventName}', ${payload});
    });

    return prisma.notificationOutbox.findFirstOrThrow({
      where: { eventName: '${eventName}' },
      orderBy: { createdAt: 'desc' },
    });
  }

  it('commits, dispatches and redacts a durable notification', async () => {
    const email = 'outbox-recipient@example.test';
    const account = await ${factory}(prisma, { email });
    const pending = await enqueueFor(account.id);

    expect(pending).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(pending.payload).not.toBeNull();
    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    expect(provider.sent).toEqual([
      expect.objectContaining({
        to: email,
        subject: '${subject}',
        text: expect.stringContaining(${expectedContent}),
      }),
    ]);
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({ where: { id: pending.id } }),
    ).resolves.toMatchObject({
      status: 'DELIVERED',
      attempts: 1,
      payload: null,
      lockedUntil: null,
      lastError: null,
      providerMessageId: 'mock-1',
      deliveredAt: expect.any(Date),
    });
  });

  it('terminally fails and redacts an unsupported event without calling a provider', async () => {
    const row = await prisma.notificationOutbox.create({
      data: {
        eventName: 'unsupported.test-event',
        payload: JSON.stringify({ value: 'must-be-cleared' }),
        nextAttemptAt: new Date(),
      },
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    expect(provider.sent).toEqual([]);
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 1,
      payload: null,
      lockedUntil: null,
      lastError: 'unsupported-event',
    });
  });
${softDeleteTest}});
`;
}

export const notificationsRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const config = notificationsConfig(context.config);
    const auth = context.featureConfig("auth") as
      | (AuthRecoveryConfig & { userEntity?: string })
      | undefined;
    const userEntity = auth?.userEntity ?? null;
    const resolvedConfig: NotificationsConfig = {
      ...config,
      events: effectiveEvents(config, auth),
    };
    const durableEvents = outboxEvents(config, auth);
    const recoveryEventSet = new Set<string>(RECOVERY_EVENT_KEYS);
    const recovery = resolvedConfig.events.filter((event) => recoveryEventSet.has(event));
    const hasDurableEvents = durableEvents.length > 0;
    const hasRecoveryEvents = recovery.length > 0;

    if (hasDurableEvents && userEntity === null) {
      throw new Error("Durable notification events require the auth feature's userEntity");
    }

    const files: RenderedFile[] = [
      file("src/generated/notifications/notification-provider.ts", PROVIDER_INTERFACE),
      file("src/generated/notifications/providers/log.provider.ts", LOG_PROVIDER),
      file("src/generated/notifications/providers/mock.provider.ts", MOCK_PROVIDER),
      file("src/generated/notifications/providers/resend.provider.ts", RESEND_PROVIDER),
      file("src/generated/notifications/notification.service.ts", serviceFile(resolvedConfig)),
      file(
        "src/generated/notifications/notification.module.ts",
        moduleFile(resolvedConfig, hasRecoveryEvents, hasDurableEvents),
      ),
      file("src/generated/notifications/notification.service.spec.ts", SERVICE_SPEC),
    ];

    if (resolvedConfig.events.length > 0) {
      files.push(
        file("src/generated/notifications/templates.ts", templatesFile(resolvedConfig)),
      );
    }

    if (hasRecoveryEvents) {
      files.push(
        file("src/generated/notifications/recovery-links.ts", RECOVERY_LINKS),
        file("src/generated/notifications/recovery-links.spec.ts", RECOVERY_LINKS_SPEC),
        file(
          "src/generated/notifications/notification.listener.ts",
          listenerFile(resolvedConfig),
        ),
        file(
          "src/generated/notifications/notification.listener.spec.ts",
          recoveryListenerSpec(resolvedConfig),
        ),
      );
    }

    if (hasDurableEvents) {
      const durableUser = context.entity(userEntity as string);
      files.push(
        file("src/generated/notifications/outbox.ts", outboxFile(durableEvents)),
        file(
          "src/generated/notifications/notification.dispatcher.ts",
          dispatcherFile(resolvedConfig, durableEvents, durableUser.name, durableUser.softDelete),
        ),
        file(
          "src/generated/notifications/outbox.spec.ts",
          outboxSpec(durableEvents),
        ),
        file(
          "src/generated/notifications/notification.dispatcher.spec.ts",
          dispatcherSpec(resolvedConfig, durableEvents, durableUser.name, durableUser.softDelete),
        ),
        file(
          "test/notification-outbox.e2e-spec.ts",
          outboxE2e(durableEvents, durableUser.name, durableUser.softDelete),
        ),
      );
    }

    const envExample = [
      {
        name: "NOTIFICATIONS_PROVIDER",
        value: config.provider,
        comment: "Delivery provider: log, resend, custom or mock. Tests use mock.",
      },
      {
        name: "NOTIFICATIONS_FROM",
        value: config.from,
        comment: "Sender address for every outbound message.",
      },
    ];

    if (config.provider === "resend") {
      envExample.push({
        name: "RESEND_API_KEY",
        value: '""',
        comment:
          "Required only when NOTIFICATIONS_PROVIDER is resend. The provider refuses to start without it.",
      });
    }

    if (hasRecoveryEvents) {
      envExample.push({
        name: "APP_PUBLIC_URL",
        value: "http://localhost:3000",
        comment:
          "Public frontend origin for verification and password-reset links. Use HTTPS in production.",
      });
    }

    const testEnv: Record<string, string> = { NOTIFICATIONS_PROVIDER: "mock" };
    if (hasRecoveryEvents) {
      testEnv.APP_PUBLIC_URL = "http://localhost:3000";
    }

    return {
      ...emptyRenderResult(),
      files,
      rootModules: [
        {
          symbol: "NotificationModule",
          from: "./generated/notifications/notification.module",
          kind: "module",
          order: 40,
        },
      ],
      envExample,
      packageDependencies: hasDurableEvents ? { "@nestjs/schedule": "5.0.1" } : {},
      // A test run must never construct a real transport or need a real key.
      testEnv,
    };
  },
};

export { EVENT_MAP };
