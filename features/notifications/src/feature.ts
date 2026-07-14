import type { SecretDefinition } from "@backend-compiler/compiler";
import type {
  FeatureContext,
  FeatureContribution,
  FeatureEntityContext,
  FeatureEntityContribution,
  FeaturePack,
} from "@backend-compiler/feature-sdk";
import { TARGET_ID } from "@backend-compiler/target-nestjs-prisma";
import { notificationsRenderer } from "./render.js";

export const NOTIFICATIONS_VERSION = "0.2.0";

/** Configuration event name to the IR event it subscribes to. */
export const EVENT_MAP: Readonly<Record<string, string>> = {
  user_registered: "user.registered",
  user_email_verification_requested: "user.email_verification_requested",
  user_password_reset_requested: "user.password_reset_requested",
  reservation_created: "reservation.created",
  reservation_confirmed: "reservation.confirmed",
  reservation_cancelled: "reservation.cancelled",
  reservation_expired: "reservation.expired",
};

export interface NotificationsConfig {
  provider: "log" | "resend" | "custom";
  from: string;
  events: string[];
  maxAttempts: number;
}

export function notificationsConfig(raw: Record<string, unknown>): NotificationsConfig {
  return raw as unknown as NotificationsConfig;
}

const SIMPLE_MAILBOX = /^[^\s<>@]+@[^\s<>@]+$/;

/** Accepts either address@example.test or a display name plus angle-bracket address. */
export function validNotificationSender(value: string): boolean {
  if (value.length === 0 || value.length > 512 || /[\r\n]/.test(value)) return false;
  if (SIMPLE_MAILBOX.test(value)) return true;

  const display = /^([^<>]{1,200})\s<([^<>]+)>$/.exec(value);
  return display !== null && display[1]!.trim().length > 0 && SIMPLE_MAILBOX.test(display[2]!);
}

/** Shape of the auth feature configuration this feature coordinates with. */
export interface AuthRecoveryConfig {
  emailVerification?: boolean;
  passwordReset?: boolean;
}

export const RECOVERY_EVENT_KEYS = [
  "user_email_verification_requested",
  "user_password_reset_requested",
] as const;

/**
 * Events delivered inline, straight from the domain event. Their single-use
 * credentials must never be persisted in an outbox row. Publishers must await
 * EventEmitter2.emitAsync so bounded provider retries finish before the request
 * is acknowledged. A crash can still require a fresh token; this deliberate
 * security trade-off is explicit in generated code and tests.
 */
export function recoveryEvents(auth: AuthRecoveryConfig | undefined): string[] {
  if (auth === undefined) {
    return [];
  }

  return [
    ...(auth.emailVerification !== false ? ["user_email_verification_requested"] : []),
    ...(auth.passwordReset !== false ? ["user_password_reset_requested"] : []),
  ];
}

/**
 * The complete set of events this feature must handle: everything the
 * specification subscribed to, plus the account-recovery events the auth
 * configuration implies. Auth recovery is never optional once auth enables it;
 * a verification flow whose token goes nowhere is a broken registration, not a
 * configuration choice.
 */
export function effectiveEvents(
  config: NotificationsConfig,
  auth: AuthRecoveryConfig | undefined,
): string[] {
  return [...new Set([...config.events, ...recoveryEvents(auth)])].sort();
}

/** Events delivered durably through the transactional outbox. */
export function outboxEvents(
  config: NotificationsConfig,
  auth: AuthRecoveryConfig | undefined,
): string[] {
  // Credential-bearing recovery events are never durable, even if one is
  // explicitly listed while its corresponding auth flow is disabled.
  const inline = new Set<string>(RECOVERY_EVENT_KEYS);
  return effectiveEvents(config, auth).filter((event) => !inline.has(event));
}

export const notificationsFeature: FeaturePack = {
  name: "notifications",
  version: NOTIFICATIONS_VERSION,
  description:
    "Event-driven outbound notifications behind a provider interface, with a development logging provider, a Resend adapter, a mock provider for tests and bounded retries.",
  dependsOn: [],
  conflictsWith: [],
  supportedTargets: [TARGET_ID],

  configSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      provider: {
        enum: ["log", "resend", "custom"],
        default: "log",
        description:
          "Default delivery provider. Custom requires CUSTOM_NOTIFICATION_PROVIDER from CustomModule. It can be overridden at runtime with NOTIFICATIONS_PROVIDER, which is how tests select the mock.",
      },
      from: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        pattern: "^[^\\r\\n]+$",
        default: "no-reply@example.com",
        description:
          "Default sender mailbox, optionally with a display name (for example, Product <no-reply@example.com>). Overridable with NOTIFICATIONS_FROM.",
      },
      events: {
        type: "array",
        items: { enum: Object.keys(EVENT_MAP) },
        uniqueItems: true,
        default: [],
        description: "Domain events that trigger a notification.",
      },
      maxAttempts: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 3,
        description:
          "Maximum provider attempts. Recovery delivery retries inline; durable outbox delivery persists its retry schedule.",
      },
    },
  },

  requiredEntities(): readonly string[] {
    return [];
  },

  validate(context: FeatureEntityContext) {
    const config = notificationsConfig(context.config);
    const issues: Array<{ code: string; path: string; message: string }> = [];

    if (!validNotificationSender(config.from)) {
      issues.push({
        code: "feature.notifications.invalid-from",
        path: "/features/notifications/from",
        message:
          "Notification sender must be an email address or a display name followed by an address in angle brackets, with no line breaks.",
      });
    }

    const needsReservations = config.events.some((event) => event.startsWith("reservation_"));
    if (needsReservations && context.featureConfig("reservations") === undefined) {
      issues.push({
        code: "feature.notifications.missing-event-source",
        path: "/features/notifications/events",
        message:
          "Reservation events are only emitted when the 'reservations' feature is enabled. Enable it, or remove the reservation_* events.",
      });
    }

    const reservations = context.featureConfig("reservations") as
      | { holdMinutes?: number }
      | undefined;
    if (
      config.events.includes("reservation_expired") &&
      reservations?.holdMinutes === 0
    ) {
      issues.push({
        code: "feature.notifications.reservation-expired-without-holds",
        path: "/features/notifications/events",
        message:
          "reservation_expired cannot occur when reservations.holdMinutes is 0. Remove that subscription or enable reservation holds.",
      });
    }

    const needsAuth = config.events.some((event) => event.startsWith("user_"));
    if ((needsAuth || needsReservations) && context.featureConfig("auth") === undefined) {
      issues.push({
        code: "feature.notifications.missing-event-source",
        path: "/features/notifications/events",
        message:
          "These events need an account to address the message to. Enable the 'auth' feature.",
      });
    }

    const auth = context.featureConfig("auth") as AuthRecoveryConfig | undefined;
    if (config.provider === "log" && recoveryEvents(auth).length > 0) {
      issues.push({
        code: "feature.notifications.recovery-provider-nondelivering",
        path: "/features/notifications/provider",
        message:
          "The log notification provider deliberately discards message content, so it cannot deliver account-recovery links. Choose provider 'resend' or 'custom', or disable both auth.emailVerification and auth.passwordReset.",
      });
    }

    if (outboxEvents(config, auth).length > 0 && context.target.database !== "postgresql") {
      issues.push({
        code: "feature.notifications.outbox-database-unsupported",
        path: "/target/database",
        message:
          "Durable notification dispatch requires PostgreSQL for atomic FOR UPDATE SKIP LOCKED claims. Choose postgresql, or remove durable notification events.",
      });
    }

    return issues;
  },

  contributeEntities(context: FeatureEntityContext): FeatureEntityContribution {
    const config = notificationsConfig(context.config);
    const auth = context.featureConfig("auth") as AuthRecoveryConfig | undefined;

    if (outboxEvents(config, auth).length === 0) {
      return {};
    }

    return {
      create: [
        {
          name: "NotificationOutbox",
          description:
            "Transactional outbox row. Written in the same transaction as the domain change; a dispatcher delivers it with bounded retries.",
          origin: "feature",
          ownerFeature: "notifications",
          crud: false,
          fields: [
            {
              name: "eventName",
              type: "string",
              required: true,
              internal: true,
              maxLength: 128,
            },
            {
              name: "payload",
              type: "text",
              required: false,
              internal: true,
              description:
                "JSON payload needed to render the message. Cleared as soon as the row reaches a terminal state.",
            },
            {
              name: "status",
              type: "string",
              required: true,
              enumValues: ["PENDING", "DELIVERED", "FAILED"],
              defaultValue: "PENDING",
              internal: true,
            },
            {
              name: "attempts",
              type: "integer",
              required: true,
              defaultValue: 0,
              minimum: 0,
              internal: true,
            },
            { name: "nextAttemptAt", type: "datetime", required: true, internal: true },
            {
              name: "lockedUntil",
              type: "datetime",
              required: false,
              internal: true,
              description:
                "Claim lease. A crashed worker's claim expires and another instance picks the row up.",
            },
            {
              name: "lastError",
              type: "string",
              required: false,
              internal: true,
              maxLength: 100,
              description:
                "Non-sensitive machine-readable category. Provider error text is never persisted.",
            },
            { name: "deliveredAt", type: "datetime", required: false, internal: true },
            {
              name: "providerMessageId",
              type: "string",
              required: false,
              internal: true,
              maxLength: 256,
            },
          ],
          indexes: [{ fields: ["status", "nextAttemptAt"], unique: false }],
        },
      ],
    };
  },

  contribute(context: FeatureContext): FeatureContribution {
    const config = notificationsConfig(context.config);
    const auth = context.featureConfig("auth") as AuthRecoveryConfig | undefined;
    const recovery = effectiveEvents(config, auth).filter((event) =>
      (RECOVERY_EVENT_KEYS as readonly string[]).includes(event),
    );
    const durable = outboxEvents(config, auth);

    const secrets: SecretDefinition[] = [
      {
        name: "NOTIFICATIONS_PROVIDER",
        feature: "notifications",
        description: `Delivery provider: log, resend, custom or mock. Defaults to '${config.provider}'.`,
        required: false,
        example: config.provider,
      },
      {
        name: "NOTIFICATIONS_FROM",
        feature: "notifications",
        description: "Sender address used for every outbound message.",
        required: false,
        example: config.from,
      },
    ];

    if (recovery.length > 0) {
      secrets.push({
        name: "APP_PUBLIC_URL",
        feature: "notifications",
        description:
          "Public frontend origin used to build email verification and password reset links.",
        required: true,
        example: "http://localhost:3000",
      });
    }

    if (config.provider === "resend") {
      secrets.push({
        name: "RESEND_API_KEY",
        feature: "notifications",
        description:
          "Resend API key. The Resend provider refuses to start without it; other providers ignore it.",
        required: false,
        example: "re_replace_me",
      });
    }

    const infrastructure: NonNullable<FeatureContribution["infrastructure"]> = [];

    if (config.provider === "resend") {
      infrastructure.push({
        kind: "service",
        name: "resend",
        feature: "notifications",
        reason: "Transactional email delivery.",
        portabilityNote:
          "Durable events use an at-least-once PostgreSQL outbox. Credential-bearing recovery events are delivered inline so raw tokens are never stored.",
      });
    }

    if (durable.length > 0) {
      infrastructure.push({
        kind: "scheduler",
        name: "notification-outbox-dispatcher",
        feature: "notifications",
        reason:
          "Claims committed outbox rows with a lease and retries delivery across process restarts.",
        portabilityNote:
          "PostgreSQL only: concurrent workers coordinate with FOR UPDATE SKIP LOCKED. Delivery is at least once.",
      });
    }

    return {
      secrets,
      infrastructure,
      customizationPoints: [
        {
          path: "src/custom/custom.module.ts",
          feature: "notifications",
          contract: "NotificationProvider",
          description:
            "Provide CUSTOM_NOTIFICATION_PROVIDER in CustomModule to deliver through your own transport instead of the generated ones.",
        },
      ],
    };
  },

  renderers: { [TARGET_ID]: notificationsRenderer },

  agentSummary:
    "Generates a NotificationProvider boundary. Non-secret events use a transactional PostgreSQL outbox with leased, at-least-once dispatch and persisted backoff. Email-verification and password-reset events are added automatically when auth enables them and are awaited inline so raw tokens never enter the outbox. Recovery links use APP_PUBLIC_URL. Providers: log (non-delivering metadata sink), resend, custom and mock (tests).",

  examples: [
    { name: "Development logging", config: { provider: "log", events: ["user_registered"] } },
    {
      name: "Resend for reservations",
      config: {
        provider: "resend",
        from: "bookings@example.com",
        events: ["reservation_confirmed", "reservation_cancelled"],
      },
    },
  ],

  conformance: [
    {
      name: "notifications-default",
      description: "Provider abstraction, all three providers and the event listener exist.",
      config: { provider: "resend", events: ["user_registered"] },
      withFeatures: { auth: {}, crud: {} },
      expectFiles: [
        "src/generated/notifications/notification-provider.ts",
        "src/generated/notifications/providers/log.provider.ts",
        "src/generated/notifications/providers/resend.provider.ts",
        "src/generated/notifications/providers/mock.provider.ts",
        "src/generated/notifications/notification.listener.ts",
        "src/generated/notifications/outbox.ts",
        "src/generated/notifications/notification.dispatcher.ts",
        "test/notification-outbox.e2e-spec.ts",
        "src/generated/notifications/notification.service.spec.ts",
      ],
      expectEndpoints: [],
    },
  ],
};
