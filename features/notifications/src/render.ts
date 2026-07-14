import { names } from "@backend-compiler/target-nestjs-prisma";
import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import { EVENT_MAP, notificationsConfig, type NotificationsConfig } from "./feature.js";

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

/** Development provider: writes the message to the log and delivers nothing. */
@Injectable()
export class LogNotificationProvider implements NotificationProvider {
  readonly id = 'log';

  private readonly logger = new Logger(LogNotificationProvider.name);

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    this.logger.log(\`[notification] to=\${message.to} subject="\${message.subject}"\`);
    this.logger.debug(message.text);

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
  NotificationMessage,
  NotificationProvider,
} from '../notification-provider';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

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
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(\`Resend rejected the message (\${response.status}): \${body.slice(0, 200)}\`);
    }

    const payload = (await response.json()) as ResendResponse;
    return { providerId: this.id, messageId: payload.id ?? null };
  }
}
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
    templates.push(`export function emailVerification(email: string, token: string): NotificationMessage {
  return {
    to: email,
    subject: 'Verify your email address',
    text: \`Use this token to verify your email address: \${token}\`,
    html: \`<p>Use this token to verify your email address:</p><pre>\${escapeHtml(token)}</pre>\`,
  };
}`);
  }

  if (config.events.includes("user_password_reset_requested")) {
    templates.push(`export function passwordReset(email: string, token: string): NotificationMessage {
  return {
    to: email,
    subject: 'Reset your password',
    text: \`Use this token to reset your password: \${token}. It expires in one hour.\`,
    html: \`<p>Use this token to reset your password. It expires in one hour.</p><pre>\${escapeHtml(token)}</pre>\`,
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

  return `import { NotificationMessage } from './notification-provider';

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
  NOTIFICATION_PROVIDER,
  NotificationMessage,
  NotificationProvider,
} from './notification-provider';

const MAX_ATTEMPTS = ${config.maxAttempts};
const BASE_BACKOFF_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Delivery with a bounded exponential backoff. A message that still fails after
 * every attempt is logged and dropped: a notification failure must never fail
 * the domain operation that triggered it.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(NOTIFICATION_PROVIDER) private readonly provider: NotificationProvider,
  ) {}

  async send(message: NotificationMessage): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.provider.send(message);
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        if (attempt === MAX_ATTEMPTS) {
          this.logger.error(
            \`Giving up on "\${message.subject}" for \${message.to} after \${attempt} attempt(s): \${reason}\`,
          );
          return false;
        }

        this.logger.warn(\`Attempt \${attempt} failed for \${message.to}: \${reason}\`);
        await delay(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }

    return false;
  }
}
`;
}

function listenerFile(config: NotificationsConfig, userEntity: string | null): string {
  const delegate = userEntity !== null ? names.delegate(userEntity) : null;
  const handlers: string[] = [];
  const templateImports = new Set<string>();

  if (config.events.includes("user_registered")) {
    templateImports.add("userRegistered");
    handlers.push(`  @OnEvent('user.registered')
  async onUserRegistered(payload: { userId: string; email: string }): Promise<void> {
    await this.notifications.send(userRegistered(payload.email));
  }`);
  }

  if (config.events.includes("user_email_verification_requested")) {
    templateImports.add("emailVerification");
    handlers.push(`  @OnEvent('user.email_verification_requested')
  async onEmailVerificationRequested(payload: {
    email: string;
    token: string;
  }): Promise<void> {
    await this.notifications.send(emailVerification(payload.email, payload.token));
  }`);
  }

  if (config.events.includes("user_password_reset_requested")) {
    templateImports.add("passwordReset");
    handlers.push(`  @OnEvent('user.password_reset_requested')
  async onPasswordResetRequested(payload: { email: string; token: string }): Promise<void> {
    await this.notifications.send(passwordReset(payload.email, payload.token));
  }`);
  }

  const reservationHandlers: Array<[string, string, string, string]> = [
    ["reservation_created", "reservation.created", "onReservationCreated", "reservationCreated"],
    [
      "reservation_confirmed",
      "reservation.confirmed",
      "onReservationConfirmed",
      "reservationConfirmed",
    ],
    [
      "reservation_cancelled",
      "reservation.cancelled",
      "onReservationCancelled",
      "reservationCancelled",
    ],
    ["reservation_expired", "reservation.expired", "onReservationExpired", "reservationExpired"],
  ];

  for (const [event, eventName, method, template] of reservationHandlers) {
    if (!config.events.includes(event)) continue;
    templateImports.add(template);

    handlers.push(`  @OnEvent('${eventName}')
  async ${method}(payload: { reservationId: string; ownerId: string }): Promise<void> {
    const email = await this.recipientEmail(payload.ownerId);

    if (email === null) {
      return;
    }

    await this.notifications.send(${template}(email, payload.reservationId));
  }`);
  }

  const needsLookup = reservationHandlers.some(([event]) => config.events.includes(event));

  const lookup =
    needsLookup && delegate !== null
      ? `
  /** Resolves the address a reservation event should be delivered to. */
  private async recipientEmail(userId: string): Promise<string | null> {
    const account = await this.prisma.${delegate}.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (account === null) {
      this.logger.warn(\`No account \${userId}; dropping notification\`);
      return null;
    }

    return account.email;
  }
`
      : "";

  const constructorArgs = needsLookup
    ? `
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
  `
    : `
    private readonly notifications: NotificationService,
  `;

  return `import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
${needsLookup ? "import { PrismaService } from '../prisma/prisma.service';\n" : ""}import { NotificationService } from './notification.service';
import { ${[...templateImports].sort().join(", ")} } from './templates';

/**
 * The only place that connects a domain event to a delivery. Nothing here is
 * imported by a domain service, so notifications can be removed from the
 * specification without touching reservation or authentication code.
 */
@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(${constructorArgs}) {}

${handlers.join("\n\n")}
${lookup}}
`;
}

function moduleFile(config: NotificationsConfig): string {
  return `import { Module } from '@nestjs/common';
import { CustomModule } from '../../custom/custom.module';
import { NotificationListener } from './notification.listener';
import {
  CUSTOM_NOTIFICATION_PROVIDER,
  NOTIFICATION_PROVIDER,
  NotificationProvider,
} from './notification-provider';
import { NotificationService } from './notification.service';
import { LogNotificationProvider } from './providers/log.provider';
import { MockNotificationProvider } from './providers/mock.provider';
import { ResendNotificationProvider } from './providers/resend.provider';

const DEFAULT_PROVIDER = '${config.provider}';
const DEFAULT_FROM = '${config.from}';

/**
 * Under test, delivery defaults to the mock provider. A test run must never be
 * able to reach a real transport, and it must never need a real API key to boot.
 * An explicit NOTIFICATIONS_PROVIDER still wins.
 */
function selectedProviderId(): string {
  const explicit = process.env.NOTIFICATIONS_PROVIDER;

  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  return process.env.NODE_ENV === 'test' ? 'mock' : DEFAULT_PROVIDER;
}

/**
 * Selects one provider at start-up. Only the selected provider is constructed,
 * so a project configured for logging never needs a Resend key.
 */
function selectProvider(custom?: NotificationProvider): NotificationProvider {
  if (custom !== undefined) {
    return custom;
  }

  const selected = selectedProviderId();
  const from = process.env.NOTIFICATIONS_FROM ?? DEFAULT_FROM;

  switch (selected) {
    case 'resend':
      return new ResendNotificationProvider(from);
    case 'mock':
      return new MockNotificationProvider();
    case 'log':
      return new LogNotificationProvider();
    default:
      throw new Error(
        \`Unknown NOTIFICATIONS_PROVIDER "\${selected}". Use one of: log, resend, mock.\`,
      );
  }
}

@Module({
  imports: [CustomModule],
  providers: [
    NotificationService,
    NotificationListener,
    {
      provide: NOTIFICATION_PROVIDER,
      useFactory: selectProvider,
      inject: [{ token: CUSTOM_NOTIFICATION_PROVIDER, optional: true }],
    },
  ],
  exports: [NotificationService, NOTIFICATION_PROVIDER],
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

export const notificationsRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const config = notificationsConfig(context.config);
    const auth = context.featureConfig("auth") as { userEntity?: string } | undefined;
    const userEntity = auth?.userEntity ?? null;

    const files: RenderedFile[] = [
      file("src/generated/notifications/notification-provider.ts", PROVIDER_INTERFACE),
      file("src/generated/notifications/providers/log.provider.ts", LOG_PROVIDER),
      file("src/generated/notifications/providers/mock.provider.ts", MOCK_PROVIDER),
      file("src/generated/notifications/providers/resend.provider.ts", RESEND_PROVIDER),
      file("src/generated/notifications/templates.ts", templatesFile(config)),
      file("src/generated/notifications/notification.service.ts", serviceFile(config)),
      file("src/generated/notifications/notification.listener.ts", listenerFile(config, userEntity)),
      file("src/generated/notifications/notification.module.ts", moduleFile(config)),
      file("src/generated/notifications/notification.service.spec.ts", SERVICE_SPEC),
    ];

    const envExample = [
      {
        name: "NOTIFICATIONS_PROVIDER",
        value: config.provider,
        comment: "Delivery provider: log, resend or mock. Tests use mock.",
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
      // A test run must never construct a real transport or need a real key.
      testEnv: { NOTIFICATIONS_PROVIDER: "mock" },
    };
  },
};

export { EVENT_MAP };
