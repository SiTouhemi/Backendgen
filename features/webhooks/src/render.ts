import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import { WEBHOOK_EVENT_CATALOG, webhooksConfig, type WebhooksConfig } from "./feature.js";

function file(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

const URL_GUARD = `import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, SocketAddress, type LookupFunction } from 'node:net';

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWebhookUrlError';
  }
}

export interface ResolvedWebhookTarget {
  address: string;
  family: 4 | 6;
}

export type WebhookResolver = (hostname: string) => Promise<ResolvedWebhookTarget[]>;

// Family-specific lists. They must stay separate: BlockList compares IPv4
// addresses as their IPv4-mapped IPv6 form, so a single list containing
// ::ffff:0:0/96 would deny every IPv4 address on the internet.
const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(network, prefix, 'ipv4');
}
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedV6.addSubnet(network, prefix, 'ipv6');
}

/**
 * The IPv4 address embedded in an IPv4-mapped IPv6 address, if any. The
 * address is canonicalized first so expanded spellings such as
 * 0:0:0:0:0:ffff:7f00:1 cannot dodge the check.
 */
function embeddedV4(address: string): string | null {
  let canonical: string;
  try {
    canonical = new SocketAddress({ address, family: 'ipv6' }).address;
  } catch {
    return null;
  }
  const match = /^::ffff:(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})$/i.exec(canonical);
  return match !== null && isIP(match[1] as string) === 4 ? (match[1] as string) : null;
}

function isBlocked(address: string, family: 4 | 6): boolean {
  if (family === 4) {
    return blockedV4.check(address, 'ipv4');
  }
  // An IPv4-mapped IPv6 destination connects to its embedded IPv4 address, so
  // judge it by the IPv4 rules.
  const mapped = embeddedV4(address);
  if (mapped !== null) {
    return blockedV4.check(mapped, 'ipv4');
  }
  return blockedV6.check(address, 'ipv6');
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\\[|\\]$/g, '').toLowerCase();
}

function isLoopback(address: string, family: 4 | 6): boolean {
  if (family === 4) {
    return address.startsWith('127.');
  }
  return address.toLowerCase() === '::1';
}

function privateNetworkOverride(address: string, family: 4 | 6): boolean {
  if (process.env.NODE_ENV === 'test' && isLoopback(address, family)) {
    return true;
  }
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK === 'true'
  );
}

function assertAllowedAddress(target: ResolvedWebhookTarget): void {
  if (isIP(target.address) !== target.family) {
    throw new UnsafeWebhookUrlError('Webhook hostname returned an invalid address');
  }
  const denied = isBlocked(target.address, target.family);
  if (denied && !privateNetworkOverride(target.address, target.family)) {
    throw new UnsafeWebhookUrlError('Webhook URL resolves to a non-public address');
  }
}

const systemResolver: WebhookResolver = async (host) => {
  const results = await lookup(host, { all: true, verbatim: true });
  return results
    .filter((entry): entry is { address: string; family: 4 | 6 } =>
      entry.family === 4 || entry.family === 6,
    )
    .map((entry) => ({ address: entry.address, family: entry.family }));
};

/**
 * Parses the URL without performing network I/O. Public destinations must use
 * HTTPS. Plain HTTP is allowed only for an explicitly permitted literal
 * loopback address in tests/local development.
 */
export function assertValidWebhookUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError('Webhook URL must be an absolute URL');
  }

  if (url.username !== '' || url.password !== '') {
    throw new UnsafeWebhookUrlError('Webhook URL must not contain credentials');
  }

  const host = hostname(url);
  const family = isIP(host);
  const loopbackHttp =
    url.protocol === 'http:' &&
    (family === 4 || family === 6) &&
    privateNetworkOverride(host, family) &&
    isLoopback(host, family);

  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new UnsafeWebhookUrlError('Webhook URL must use HTTPS');
  }

  if (family === 4 || family === 6) {
    assertAllowedAddress({ address: host, family });
  }
  return url;
}

/**
 * Resolves once, rejects the whole hostname if any answer is non-public, and
 * returns the address that the HTTP client must use. Passing that address into
 * postWebhook closes the DNS-rebinding gap between validation and connection.
 */
export async function resolveWebhookTarget(
  url: URL,
  resolver: WebhookResolver = systemResolver,
): Promise<ResolvedWebhookTarget> {
  const host = hostname(url);
  const family = isIP(host);
  const targets: ResolvedWebhookTarget[] =
    family === 4 || family === 6
      ? [{ address: host, family: family as 4 | 6 }]
      : await resolver(host);

  if (targets.length === 0) {
    throw new UnsafeWebhookUrlError('Webhook hostname did not resolve');
  }
  for (const target of targets) {
    assertAllowedAddress(target);
  }
  return targets[0]!;
}

/**
 * Sends one request while pinning DNS to the already validated address. The
 * original URL remains intact, so HTTPS still verifies the certificate and SNI
 * against the endpoint hostname rather than the selected IP.
 */
export async function postWebhook(
  url: URL,
  target: ResolvedWebhookTarget,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<number> {
  const pinnedLookup: LookupFunction = (_host, _options, callback) => {
    callback(null, target.address, target.family);
  };
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<number>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'POST',
        headers,
        lookup: pinnedLookup,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        response.once('error', reject);
        response.once('end', () => resolve(response.statusCode ?? 0));
        response.resume();
      },
    );
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}
`;

const URL_GUARD_SPEC = `import {
  assertValidWebhookUrlShape,
  resolveWebhookTarget,
  UnsafeWebhookUrlError,
} from './url-guard';

describe('webhook URL guard', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('accepts a public HTTPS URL', () => {
    process.env.NODE_ENV = 'production';
    expect(assertValidWebhookUrlShape('https://hooks.example.com/ingest').hostname).toBe(
      'hooks.example.com',
    );
  });

  it('rejects plaintext, credentials and private literals', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertValidWebhookUrlShape('http://hooks.example.com')).toThrow(UnsafeWebhookUrlError);
    expect(() => assertValidWebhookUrlShape('https://user:pass@hooks.example.com')).toThrow(
      UnsafeWebhookUrlError,
    );
    expect(() => assertValidWebhookUrlShape('https://10.0.0.5/ingest')).toThrow(UnsafeWebhookUrlError);
    expect(() => assertValidWebhookUrlShape('https://169.254.169.254/latest')).toThrow(
      UnsafeWebhookUrlError,
    );
    expect(() => assertValidWebhookUrlShape('https://127.0.0.1/ingest')).toThrow(UnsafeWebhookUrlError);
  });

  it('allows only loopback HTTP under test', () => {
    process.env.NODE_ENV = 'test';
    expect(assertValidWebhookUrlShape('http://127.0.0.1:8080/hook').protocol).toBe('http:');
    expect(() => assertValidWebhookUrlShape('http://10.0.0.5/hook')).toThrow(
      UnsafeWebhookUrlError,
    );
  });

  it('rejects every non-public DNS answer, including less obvious reserved ranges', async () => {
    process.env.NODE_ENV = 'production';
    const url = assertValidWebhookUrlShape('https://hooks.example.com/ingest');

    for (const address of [
      '198.18.0.1',
      '224.0.0.1',
      '2001::1',
      '2002:0a00::1',
      '3fff::1',
      '5f00::1',
      'fe90::1',
      'febf::1',
      'fec0::1',
      'ff02::1',
    ]) {
      const family = address.includes(':') ? 6 : 4;
      await expect(
        resolveWebhookTarget(url, async () => [{ address, family } as const]),
      ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
    }

    await expect(
      resolveWebhookTarget(url, async () => [{ address: '8.8.8.8', family: 6 }]),
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it('accepts public IPv4 and IPv6 answers', async () => {
    process.env.NODE_ENV = 'production';
    const url = assertValidWebhookUrlShape('https://hooks.example.com/ingest');

    await expect(
      resolveWebhookTarget(url, async () => [{ address: '8.8.8.8', family: 4 } as const]),
    ).resolves.toEqual({ address: '8.8.8.8', family: 4 });
    await expect(
      resolveWebhookTarget(url, async () => [
        { address: '2606:4700::6810:84e5', family: 6 } as const,
      ]),
    ).resolves.toEqual({ address: '2606:4700::6810:84e5', family: 6 });
    expect(assertValidWebhookUrlShape('https://8.8.8.8/ingest').hostname).toBe('8.8.8.8');
  });

  it('judges IPv4-mapped IPv6 answers by their embedded IPv4 address', async () => {
    process.env.NODE_ENV = 'production';
    const url = assertValidWebhookUrlShape('https://hooks.example.com/ingest');

    for (const address of ['::ffff:127.0.0.1', '::ffff:10.0.0.5', '0:0:0:0:0:ffff:7f00:1']) {
      await expect(
        resolveWebhookTarget(url, async () => [{ address, family: 6 } as const]),
      ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
    }

    await expect(
      resolveWebhookTarget(url, async () => [{ address: '::ffff:8.8.8.8', family: 6 } as const]),
    ).resolves.toEqual({ address: '::ffff:8.8.8.8', family: 6 });
  });
});
`;

const SIGNATURE = `import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Versioned canonical input. The delivery id and event name are signed so they
 * cannot be replaced to bypass receiver deduplication or dispatch the body as a
 * different event.
 */
function canonical(
  deliveryId: string,
  eventName: string,
  timestamp: string,
  body: string,
): string {
  return ['v1', deliveryId, eventName, timestamp, body].join('\\n');
}

export function signWebhook(
  secret: string,
  deliveryId: string,
  eventName: string,
  timestamp: string,
  body: string,
): string {
  return (
    'v1=' +
    createHmac('sha256', secret)
      .update(canonical(deliveryId, eventName, timestamp, body))
      .digest('hex')
  );
}

export function verifyWebhookSignature(
  secret: string,
  deliveryId: string,
  eventName: string,
  timestamp: string,
  body: string,
  provided: string,
  options: { nowMs?: number; toleranceSeconds?: number } = {},
): boolean {
  const sentAt = Number(timestamp);
  const nowMs = options.nowMs ?? Date.now();
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (
    !Number.isSafeInteger(sentAt) ||
    toleranceSeconds < 0 ||
    Math.abs(Math.floor(nowMs / 1000) - sentAt) > toleranceSeconds
  ) {
    return false;
  }

  const expected = signWebhook(secret, deliveryId, eventName, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
`;

const SIGNATURE_SPEC = `import { signWebhook, verifyWebhookSignature } from './signature';

describe('webhook signatures', () => {
  it('binds id, event, timestamp and body and rejects stale requests', () => {
    const nowMs = 1_700_000_000_000;
    const signature = signWebhook(
      'secret',
      'delivery-1',
      'reservation.created',
      '1700000000',
      '{"a":1}',
    );
    const verify = (
      deliveryId: string,
      eventName: string,
      timestamp: string,
      body: string,
      candidate = signature,
    ) =>
      verifyWebhookSignature(
        'secret',
        deliveryId,
        eventName,
        timestamp,
        body,
        candidate,
        { nowMs },
      );

    expect(verify('delivery-1', 'reservation.created', '1700000000', '{"a":1}')).toBe(true);
    expect(verify('delivery-2', 'reservation.created', '1700000000', '{"a":1}')).toBe(false);
    expect(verify('delivery-1', 'reservation.cancelled', '1700000000', '{"a":1}')).toBe(false);
    expect(verify('delivery-1', 'reservation.created', '1700000000', '{"a":2}')).toBe(false);
    expect(verify('delivery-1', 'reservation.created', '1699999000', '{"a":1}')).toBe(false);
    expect(
      verifyWebhookSignature(
        'other',
        'delivery-1',
        'reservation.created',
        '1700000000',
        '{"a":1}',
        signature,
        { nowMs },
      ),
    ).toBe(false);
  });
});
`;

function outboxFile(tenantAware: boolean): string {
  const catalog = WEBHOOK_EVENT_CATALOG.filter(
    (event) => !tenantAware || event !== "user.registered",
  );

  return `import { Prisma } from '@prisma/client';

export const WEBHOOK_EVENT_CATALOG = ${JSON.stringify(catalog)} as const;
export type WebhookEventName = (typeof WEBHOOK_EVENT_CATALOG)[number];

/**
 * Writes into the same transaction as the domain state change. Once that
 * transaction commits, fan-out can retry without losing the event. Delivery is
 * at least once, so consumers must deduplicate the signed delivery id.
 */
export async function enqueueWebhookEvent(
  tx: Prisma.TransactionClient,
  eventName: WebhookEventName,
  payload: Record<string, unknown>${tenantAware ? ",\n  organizationId: string" : ""},
): Promise<void> {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw new Error('Webhook payload exceeds 64 KiB');
  }

  await tx.webhookEvent.create({
    data: {
      eventName,
      payload: serialized,
      nextAttemptAt: new Date(),${tenantAware ? "\n      organizationId," : ""}
    },
  });
}
`;
}

function serviceFile(tenantAware: boolean): string {
  const scopeImports = tenantAware ? "RequestScope, requireOrganization" : "RequestScope";
  const tenantWhere = tenantAware ? "{ organizationId: requireOrganization(scope) }" : "{}";
  const tenantCreate = tenantAware ? "\n        organizationId: requireOrganization(scope)," : "";
  // Without tenancy the scope only proves authentication; reference it so strict
  // TS does not flag the parameter, and the shape stays identical either way.
  const scopeUse = tenantAware ? "" : "\n    void scope;";

  return `import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ${scopeImports} } from '../common/scope';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertValidWebhookUrlShape,
  resolveWebhookTarget,
  UnsafeWebhookUrlError,
} from './url-guard';
import { WEBHOOK_EVENT_CATALOG } from './webhook-outbox';

export interface CreateWebhookInput {
  url: string;
  events: string[];
}

@Injectable()
export class WebhookService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateWebhookInput, scope: RequestScope): Promise<{ id: string; secret: string }> {${scopeUse}
    let normalizedUrl = input.url;
    try {
      const url = assertValidWebhookUrlShape(input.url);
      await resolveWebhookTarget(url);
      normalizedUrl = url.toString();
    } catch (error) {
      if (error instanceof UnsafeWebhookUrlError) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException('Webhook hostname could not be resolved');
    }

    const unknown = input.events.filter(
      (event) => !(WEBHOOK_EVENT_CATALOG as readonly string[]).includes(event),
    );
    const uniqueEvents = new Set(input.events);
    if (
      input.events.length === 0 ||
      uniqueEvents.size !== input.events.length ||
      unknown.length > 0
    ) {
      throw new BadRequestException(
        'events must be a unique, non-empty subset of: ' + WEBHOOK_EVENT_CATALOG.join(', '),
      );
    }

    // Shown once; the consumer stores it to verify signatures.
    const secret = 'whsec_' + randomBytes(24).toString('base64url');
    const created = await this.prisma.webhookEndpoint.create({
      data: {
        url: normalizedUrl,
        events: JSON.stringify([...uniqueEvents]),
        secret,
        active: true,${tenantCreate}
      },
      select: { id: true },
    });

    return { id: created.id, secret };
  }

  async list(scope: RequestScope): Promise<Array<{ id: string; url: string; events: string[]; active: boolean }>> {${scopeUse}
    const rows = await this.prisma.webhookEndpoint.findMany({
      where: ${tenantWhere},
      orderBy: { createdAt: 'asc' },
      select: { id: true, url: true, events: true, active: true },
    });
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      events: JSON.parse(row.events) as string[],
      active: row.active,
    }));
  }

  async remove(id: string, scope: RequestScope): Promise<boolean> {${scopeUse}
    const result = await this.prisma.webhookEndpoint.deleteMany({
      where: { id, ...${tenantWhere} },
    });
    return result.count === 1;
  }
}
`;
}

function dispatcherFile(config: WebhooksConfig, tenantAware: boolean): string {
  return `import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  QUEUE_BATCH_SIZE,
  QUEUE_LEASE_MS,
  queueClaimSql,
  queueRetryDelayMs,
} from '../common/queue-runner';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertValidWebhookUrlShape,
  postWebhook,
  resolveWebhookTarget,
  UnsafeWebhookUrlError,
} from './url-guard';
import { signWebhook } from './signature';

const MAX_ATTEMPTS = ${config.maxAttempts};
const DISABLE_AFTER_FAILURES = ${config.disableAfterFailures};
const DISPATCH_INTERVAL_MS = 5_000;
const MAX_BATCHES_PER_TICK = 10;
const REQUEST_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;

interface RawClaimedEvent {
  id: string;
  eventName: string;
  payload: string | null;
  attempts: number;
  createdAt: Date;${tenantAware ? "\n  organizationId: string;" : ""}
}

interface ClaimedEvent extends RawClaimedEvent {
  leaseUntil: Date;
}

interface ClaimedDelivery {
  id: string;
  eventName: string;
  payload: string | null;
  attempts: number;
  leaseUntil: Date;
}

/**
 * Both stages use short FOR UPDATE SKIP LOCKED claim transactions followed by
 * leased work. Fan-out is idempotent through the unique event/endpoint key;
 * delivery is at least once and consumers deduplicate the signed delivery id.
 */
@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Interval(DISPATCH_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
        if ((await this.fanOut()) < QUEUE_BATCH_SIZE) break;
      }
      for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
        if ((await this.deliverBatch()) < QUEUE_BATCH_SIZE) break;
      }
    } catch (error) {
      this.logger.error(
        'Webhook dispatch tick failed',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }

  /** Public for tests: expand captured events into per-endpoint deliveries. */
  async fanOut(): Promise<number> {
    const leaseUntil = new Date(Date.now() + QUEUE_LEASE_MS);
    const events = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RawClaimedEvent[]>(
        queueClaimSql(
          'WebhookEvent',
          ['id', 'eventName', 'payload', 'attempts', 'createdAt'${tenantAware ? ", 'organizationId'" : ""}],
          QUEUE_BATCH_SIZE,
        ),
      );
      if (rows.length === 0) return [];

      await tx.webhookEvent.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: 'PENDING' },
        data: { lockedUntil: leaseUntil, attempts: { increment: 1 } },
      });
      return rows.map((row) => ({ ...row, attempts: row.attempts + 1, leaseUntil }));
    });

    for (const event of events) {
      await this.fanOutEvent(event);
    }

    return events.length;
  }

  private async fanOutEvent(event: ClaimedEvent): Promise<void> {
    try {
      if (event.attempts > MAX_ATTEMPTS) {
        await this.settleEventFailure(event, true, 'retry-limit-reached');
        return;
      }

      const endpoints = await this.prisma.webhookEndpoint.findMany({
        where: {
          active: true,
          createdAt: { lte: event.createdAt },${tenantAware ? "\n          organizationId: event.organizationId," : ""}
        },
        select: { id: true, events: true },
      });
      const matching = endpoints.filter((endpoint) => {
        try {
          const subscribed: unknown = JSON.parse(endpoint.events);
          if (
            Array.isArray(subscribed) &&
            subscribed.every((value) => typeof value === 'string')
          ) {
            return subscribed.includes(event.eventName);
          }
        } catch {
          // Fall through to the corruption warning below.
        }
        this.logger.warn(
          'Skipping webhook endpoint ' + endpoint.id + ' with an invalid event subscription',
        );
        return false;
      });

      await this.prisma.$transaction(async (tx) => {
        const settled = await tx.webhookEvent.updateMany({
          where: {
            id: event.id,
            status: 'PENDING',
            lockedUntil: event.leaseUntil,
          },
          data: { status: 'DONE', payload: null, lockedUntil: null, lastError: null },
        });
        if (settled.count !== 1 || matching.length === 0) return;

        await tx.webhookDelivery.createMany({
          data: matching.map((endpoint) => ({
            endpointId: endpoint.id,
            eventId: event.id,
            eventName: event.eventName,
            payload: event.payload,
            nextAttemptAt: new Date(),
          })),
          skipDuplicates: true,
        });
      });
    } catch {
      await this.settleEventFailure(
        event,
        event.attempts >= MAX_ATTEMPTS,
        event.attempts >= MAX_ATTEMPTS ? 'retry-limit-reached' : 'fanout-error',
      );
    }
  }

  private async settleEventFailure(
    event: ClaimedEvent,
    terminal: boolean,
    error: string,
  ): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id: event.id, status: 'PENDING', lockedUntil: event.leaseUntil },
      data: terminal
        ? { status: 'FAILED', payload: null, lockedUntil: null, lastError: error }
        : {
            nextAttemptAt: new Date(
              Date.now() +
                queueRetryDelayMs(event.attempts, BASE_BACKOFF_MS, MAX_BACKOFF_MS),
            ),
            lockedUntil: null,
            lastError: error,
          },
    });
  }

  /** Public for tests: deliver one batch of pending deliveries. */
  async deliverBatch(): Promise<number> {
    const leaseUntil = new Date(Date.now() + QUEUE_LEASE_MS);
    const rows = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<Omit<ClaimedDelivery, 'leaseUntil'>>>(
        queueClaimSql('WebhookDelivery', ['id', 'eventName', 'payload', 'attempts'], QUEUE_BATCH_SIZE),
      );
      if (claimed.length === 0) return [];
      await tx.webhookDelivery.updateMany({
        where: { id: { in: claimed.map((row) => row.id) }, status: 'PENDING' },
        data: { lockedUntil: leaseUntil, attempts: { increment: 1 } },
      });
      return claimed.map((row) => ({ ...row, attempts: row.attempts + 1, leaseUntil }));
    });

    await Promise.all(rows.map(async (row) => this.deliver(row)));
    return rows.length;
  }

  private async deliver(row: ClaimedDelivery): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: row.id },
      include: { endpoint: true },
    });
    if (delivery === null) return;

    const endpoint = delivery.endpoint;
    if (!endpoint.active) {
      await this.cancel(row, 'endpoint-inactive');
      return;
    }
    if (row.attempts > MAX_ATTEMPTS) {
      await this.fail(row, endpoint.id, 'retry-limit-reached', null);
      return;
    }

    const body = row.payload ?? '{}';
    const timestamp = String(Math.floor(Date.now() / 1000));

    try {
      const url = assertValidWebhookUrlShape(endpoint.url);
      const target = await resolveWebhookTarget(url);
      const status = await postWebhook(
        url,
        target,
        {
          'content-type': 'application/json',
          'x-webhook-id': delivery.id,
          'x-webhook-timestamp': timestamp,
          'x-webhook-event': row.eventName,
          'x-webhook-signature': signWebhook(
            endpoint.secret,
            delivery.id,
            row.eventName,
            timestamp,
            body,
          ),
        },
        body,
        REQUEST_TIMEOUT_MS,
      );

      // 408/425/429 and server failures are temporary. Other 4xx responses
      // indicate a bad endpoint or credentials and should not be hammered.
      const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
      if (status >= 200 && status < 300) {
        await this.succeed(row, endpoint.id, status);
      } else if (retryable && row.attempts < MAX_ATTEMPTS) {
        await this.retry(row, 'status ' + String(status), status);
      } else {
        await this.fail(row, endpoint.id, 'status ' + String(status), status);
      }
    } catch (error) {
      const message = error instanceof Error ? error.name : 'delivery-error';
      if (!(error instanceof UnsafeWebhookUrlError) && row.attempts < MAX_ATTEMPTS) {
        await this.retry(row, message, null);
      } else {
        await this.fail(row, endpoint.id, message, null);
      }
    }
  }

  private async succeed(
    row: ClaimedDelivery,
    endpointId: string,
    status: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const settled = await tx.webhookDelivery.updateMany({
        where: { id: row.id, status: 'PENDING', lockedUntil: row.leaseUntil },
        data: {
          status: 'DONE',
          payload: null,
          lockedUntil: null,
          responseStatus: status,
          lastError: null,
        },
      });
      if (settled.count === 1) {
        await tx.webhookEndpoint.updateMany({
          where: { id: endpointId },
          data: { consecutiveFailures: 0 },
        });
      }
    });
  }

  private async retry(
    row: ClaimedDelivery,
    error: string,
    status: number | null,
  ): Promise<void> {
    await this.prisma.webhookDelivery.updateMany({
      where: { id: row.id, status: 'PENDING', lockedUntil: row.leaseUntil },
      data: {
        nextAttemptAt: new Date(
          Date.now() + queueRetryDelayMs(row.attempts, BASE_BACKOFF_MS, MAX_BACKOFF_MS),
        ),
        lockedUntil: null,
        lastError: error,
        responseStatus: status,
      },
    });
  }

  private async cancel(row: ClaimedDelivery, error: string): Promise<void> {
    await this.prisma.webhookDelivery.updateMany({
      where: { id: row.id, status: 'PENDING', lockedUntil: row.leaseUntil },
      data: {
        status: 'FAILED',
        payload: null,
        lockedUntil: null,
        lastError: error,
      },
    });
  }

  private async fail(
    row: ClaimedDelivery,
    endpointId: string,
    error: string,
    status: number | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const settled = await tx.webhookDelivery.updateMany({
        where: { id: row.id, status: 'PENDING', lockedUntil: row.leaseUntil },
        data: {
          status: 'FAILED',
          payload: null,
          lockedUntil: null,
          lastError: error,
          responseStatus: status,
        },
      });
      if (settled.count !== 1) return;

      const endpoint = await tx.webhookEndpoint.update({
        where: { id: endpointId },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true },
      });
      if (endpoint.consecutiveFailures < DISABLE_AFTER_FAILURES) return;

      await tx.webhookEndpoint.update({
        where: { id: endpointId },
        data: { active: false },
      });
      await tx.webhookDelivery.updateMany({
        where: { endpointId, status: 'PENDING' },
        data: {
          status: 'FAILED',
          payload: null,
          lockedUntil: null,
          lastError: 'endpoint-disabled',
        },
      });
    });
  }
}
`;
}

function controllerFile(
  tenantAware: boolean,
  accountAdminRoles: readonly string[],
  organizationAdminRoles: readonly string[],
): string {
  const decorator = tenantAware
    ? `@OrgRoles(${organizationAdminRoles.map((role) => JSON.stringify(role)).join(", ")})`
    : `@Roles(${accountAdminRoles.map((role) => JSON.stringify(role)).join(", ")})`;
  const roleImport = tenantAware
    ? "import { OrgRoles } from '../organizations/decorators/org-roles.decorator';\n"
    : "import { Roles } from '../auth/decorators/roles.decorator';\n";
  const eventCount = tenantAware
    ? WEBHOOK_EVENT_CATALOG.filter((event) => event !== "user.registered").length
    : WEBHOOK_EVENT_CATALOG.length;

  return `import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiErrorDto } from '../common/api-error.dto';
import { CurrentScope, RequestScope } from '../common/scope';
${roleImport}import { WebhookService } from './webhook.service';

export class CreateWebhookDto {
  @ApiProperty({ maxLength: 2000, description: 'HTTPS destination for signed event POSTs' })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2000)
  url!: string;

  @ApiProperty({ type: [String], description: 'Event names to subscribe to' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(${eventCount})
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  events!: string[];
}

export class WebhookCreatedDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Signing secret. Shown once; store it now.' })
  secret!: string;
}

export class WebhookEndpointDto {
  @ApiProperty() id!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ type: [String] }) events!: string[];
  @ApiProperty() active!: boolean;
}

@ApiTags('webhooks')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: ApiErrorDto })
${decorator}
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly service: WebhookService) {}

  @Post()
  @ApiCreatedResponse({ type: WebhookCreatedDto })
  create(@Body() dto: CreateWebhookDto, @CurrentScope() scope: RequestScope): Promise<WebhookCreatedDto> {
    return this.service.create(dto, scope);
  }

  @Get()
  @ApiOkResponse({ type: [WebhookEndpointDto] })
  list(@CurrentScope() scope: RequestScope): Promise<WebhookEndpointDto[]> {
    return this.service.list(scope);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ApiErrorDto })
  async remove(@Param('id') id: string, @CurrentScope() scope: RequestScope): Promise<void> {
    const removed = await this.service.remove(id, scope);
    if (!removed) {
      throw new NotFoundException('Webhook endpoint not found');
    }
  }
}
`;
}

function moduleFile(): string {
  return `import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { WebhookController } from './webhook.controller';
import { WebhookDispatcher } from './webhook-dispatcher';
import { WebhookService } from './webhook.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookDispatcher],
  exports: [WebhookService],
})
export class WebhooksModule {}
`;
}

function secureWebhooksE2e(context: TargetRenderContext): string | null {
  if (!context.hasFeature("auth")) return null;
  const prefix = context.settings.apiPrefix;
  const config = webhooksConfig(context.config);
  const tenantAware = context.hasFeature("organizations");
  const auth = context.featureConfig("auth") as
    | { roles?: string[]; defaultRole?: string }
    | undefined;
  const accountRoles = auth?.roles ?? ["admin", "user"];
  const accountDefault = auth?.defaultRole ?? accountRoles.at(-1) ?? "user";
  const accountAdmin = accountRoles.find((role) => role !== accountDefault) ?? accountRoles[0]!;
  const organizations = context.featureConfig("organizations") as
    | { roles?: string[]; defaultRole?: string }
    | undefined;
  const organizationRoles = organizations?.roles ?? ["owner", "admin", "member"];
  const organizationDefault =
    organizations?.defaultRole ?? organizationRoles.at(-1) ?? "member";

  return `import { INestApplication } from '@nestjs/common';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { WebhookDispatcher } from '../src/generated/webhooks/webhook-dispatcher';
import { enqueueWebhookEvent } from '../src/generated/webhooks/webhook-outbox';
import { verifyWebhookSignature } from '../src/generated/webhooks/signature';
import { registerAccount } from './utils/auth-helper';
import { resetDatabase } from './utils/reset';
import { createTestApp${tenantAware ? ", uniqueString" : ""} } from './utils/test-app';

interface Captured {
  id: string;
  signature: string;
  timestamp: string;
  event: string;
  body: string;
}

interface ManagementContext {
  headers: Record<string, string>;
  organizationId: string | null;
}

describe('Webhooks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: WebhookDispatcher;
  let sink: Server;
  let sinkUrl: string;
  let received: Captured[] = [];
  let respondWith = 200;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    dispatcher = app.get(WebhookDispatcher);
    sink = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          id: String(req.headers['x-webhook-id'] ?? ''),
          signature: String(req.headers['x-webhook-signature'] ?? ''),
          timestamp: String(req.headers['x-webhook-timestamp'] ?? ''),
          event: String(req.headers['x-webhook-event'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.statusCode = respondWith;
        res.end();
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    sinkUrl = 'http://127.0.0.1:' + String((sink.address() as AddressInfo).port) + '/hook';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    received = [];
    respondWith = 200;
  });

  async function managementContext(): Promise<ManagementContext> {
    const account = await registerAccount(app, prisma, {
      role: ${JSON.stringify(accountAdmin)},
    });
${tenantAware ? `    const organization = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', 'Bearer ' + account.accessToken)
      .send({ name: uniqueString(24) })
      .expect(201);
    const organizationId = organization.body.id as string;
    return {
      organizationId,
      headers: {
        Authorization: 'Bearer ' + account.accessToken,
        'X-Organization-Id': organizationId,
      },
    };` : `    return {
      organizationId: null,
      headers: { Authorization: 'Bearer ' + account.accessToken },
    };`}
  }

  async function enqueueEvent(
    management: ManagementContext,
    suffix: string,
  ): Promise<void> {
${tenantAware ? "" : "    void management;\n"}    await prisma.$transaction(async (tx) => {
      await enqueueWebhookEvent(
        tx,
        'reservation.created',
        {
          reservationId: 'reservation-' + suffix,
          resourceId: 'resource-' + suffix,
          ownerId: 'owner-' + suffix,
        }${tenantAware ? ",\n        management.organizationId!" : ""},
      );
    });
  }

  async function registerEndpoint(management: ManagementContext): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/${prefix}/webhooks')
      .set(management.headers)
      .send({ url: sinkUrl, events: ['reservation.created'] })
      .expect(201);
  }

  it('requires an administrator and rejects unsafe destinations', async () => {
    const management = await managementContext();
    await request(app.getHttpServer())
      .post('/${prefix}/webhooks')
      .set(management.headers)
      .send({ url: 'http://example.com/hook', events: ['reservation.created'] })
      .expect(400);
    await request(app.getHttpServer())
      .post('/${prefix}/webhooks')
      .set(management.headers)
      .send({ url: 'https://10.0.0.1/hook', events: ['reservation.created'] })
      .expect(400);

${tenantAware ? `    const member = await registerAccount(app, prisma);
    await prisma.membership.create({
      data: {
        organizationId: management.organizationId!,
        userId: member.id,
        role: ${JSON.stringify(organizationDefault)},
      },
    });
    await request(app.getHttpServer())
      .post('/${prefix}/webhooks')
      .set({
        Authorization: 'Bearer ' + member.accessToken,
        'X-Organization-Id': management.organizationId!,
      })
      .send({ url: sinkUrl, events: ['reservation.created'] })
      .expect(403);` : `    const member = await registerAccount(app, prisma);
    await request(app.getHttpServer())
      .post('/${prefix}/webhooks')
      .set('Authorization', 'Bearer ' + member.accessToken)
      .send({ url: sinkUrl, events: ['reservation.created'] })
      .expect(403);`}
  });

  it('transactionally fans out and delivers a signed, non-secret response', async () => {
    const management = await managementContext();
    const registered = await registerEndpoint(management);
    expect(registered.body.secret).toMatch(/^whsec_/);
    const secret = registered.body.secret as string;

    const listed = await request(app.getHttpServer())
      .get('/${prefix}/webhooks')
      .set(management.headers)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).not.toHaveProperty('secret');

    await enqueueEvent(management, 'signed');
    await dispatcher.fanOut();
    await dispatcher.deliverBatch();

    expect(received).toHaveLength(1);
    const delivered = received[0]!;
    expect(delivered.event).toBe('reservation.created');
    expect(
      verifyWebhookSignature(
        secret,
        delivered.id,
        delivered.event,
        delivered.timestamp,
        delivered.body,
        delivered.signature,
      ),
    ).toBe(true);
    expect(
      verifyWebhookSignature(
        secret,
        delivered.id + '-changed',
        delivered.event,
        delivered.timestamp,
        delivered.body,
        delivered.signature,
      ),
    ).toBe(false);

    const delivery = await prisma.webhookDelivery.findFirstOrThrow();
    expect(delivery.status).toBe('DONE');
    expect(delivery.payload).toBeNull();
    await expect(
      prisma.webhookEvent.count({ where: { eventName: 'reservation.created' } }),
    ).resolves.toBe(1);
    // The registration event predates the endpoint and must not be delivered
    // retroactively.
    await expect(prisma.webhookDelivery.count()).resolves.toBe(1);
  });

  it('retries, terminally fails, disables the endpoint, and clears queued payloads', async () => {
    const management = await managementContext();
    const registered = await registerEndpoint(management);
    respondWith = 500;

    for (let failure = 0; failure < ${config.disableAfterFailures}; failure += 1) {
      await enqueueEvent(management, 'failure-' + String(failure));
      await dispatcher.fanOut();
      for (let attempt = 0; attempt < ${config.maxAttempts}; attempt += 1) {
        await prisma.webhookDelivery.updateMany({
          where: { status: 'PENDING' },
          data: { nextAttemptAt: new Date(Date.now() - 1000), lockedUntil: null },
        });
        await dispatcher.deliverBatch();
      }
    }

    const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: registered.body.id as string },
    });
    expect(endpoint.active).toBe(false);
    await expect(
      prisma.webhookDelivery.count({ where: { status: 'PENDING' } }),
    ).resolves.toBe(0);
    const terminal = await prisma.webhookDelivery.findMany();
    expect(terminal.every((row) => row.status === 'FAILED' && row.payload === null)).toBe(true);
  });
${tenantAware ? `
  it('never fans an organization event out across tenant boundaries', async () => {
    const first = await managementContext();
    const second = await managementContext();
    await registerEndpoint(first);
    await registerEndpoint(second);

    await enqueueEvent(first, 'tenant-isolation');
    await dispatcher.fanOut();
    await dispatcher.deliverBatch();

    expect(received).toHaveLength(1);
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      include: { endpoint: true },
    });
    expect(delivery.endpoint.organizationId).toBe(first.organizationId);
  });
` : ""}});
`;
}

export const webhooksRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const config = webhooksConfig(context.config);
    const tenantAware = context.hasFeature("organizations");
    const auth = context.featureConfig("auth") as
      | { roles?: string[]; defaultRole?: string }
      | undefined;
    const accountRoles = auth?.roles ?? ["admin", "user"];
    const accountDefault = auth?.defaultRole ?? accountRoles.at(-1) ?? "user";
    const accountAdminRoles = accountRoles
      .filter((role) => role !== accountDefault)
      .slice(0, 1);
    const organizations = context.featureConfig("organizations") as
      | { roles?: string[]; defaultRole?: string }
      | undefined;
    const organizationRoles = organizations?.roles ?? ["owner", "admin", "member"];
    const organizationDefault =
      organizations?.defaultRole ?? organizationRoles.at(-1) ?? "member";
    const organizationAdminRoles = organizationRoles.filter(
      (role) => role !== organizationDefault,
    );

    const files: RenderedFile[] = [
      file("src/generated/webhooks/url-guard.ts", URL_GUARD),
      file("src/generated/webhooks/url-guard.spec.ts", URL_GUARD_SPEC),
      file("src/generated/webhooks/signature.ts", SIGNATURE),
      file("src/generated/webhooks/signature.spec.ts", SIGNATURE_SPEC),
      file("src/generated/webhooks/webhook-outbox.ts", outboxFile(tenantAware)),
      file("src/generated/webhooks/webhook.service.ts", serviceFile(tenantAware)),
      file("src/generated/webhooks/webhook-dispatcher.ts", dispatcherFile(config, tenantAware)),
      file(
        "src/generated/webhooks/webhook.controller.ts",
        controllerFile(tenantAware, accountAdminRoles, organizationAdminRoles),
      ),
      file("src/generated/webhooks/webhooks.module.ts", moduleFile()),
    ];

    const e2e = secureWebhooksE2e(context);
    if (e2e !== null) {
      files.push(file("test/webhooks.e2e-spec.ts", e2e));
    }

    return {
      ...emptyRenderResult(),
      files,
      rootModules: [
        {
          symbol: "WebhooksModule",
          from: "./generated/webhooks/webhooks.module",
          kind: "module",
          order: 70,
        },
      ],
      packageDependencies: { "@nestjs/schedule": "5.0.1" },
    };
  },
};
