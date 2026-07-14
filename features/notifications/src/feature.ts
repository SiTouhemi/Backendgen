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
  provider: "log" | "resend";
  from: string;
  events: string[];
  maxAttempts: number;
}

export function notificationsConfig(raw: Record<string, unknown>): NotificationsConfig {
  return raw as unknown as NotificationsConfig;
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
        enum: ["log", "resend"],
        default: "log",
        description:
          "Default delivery provider. It can be overridden at runtime with NOTIFICATIONS_PROVIDER, which is how tests select the mock.",
      },
      from: {
        type: "string",
        default: "no-reply@example.com",
        description: "Default sender address, overridable with NOTIFICATIONS_FROM.",
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
        description: "Delivery attempts before a failure is logged and dropped.",
      },
    },
  },

  requiredEntities(): readonly string[] {
    return [];
  },

  validate(context: FeatureEntityContext) {
    const config = notificationsConfig(context.config);
    const issues: Array<{ code: string; path: string; message: string }> = [];

    const needsReservations = config.events.some((event) => event.startsWith("reservation_"));
    if (needsReservations && context.featureConfig("reservations") === undefined) {
      issues.push({
        code: "feature.notifications.missing-event-source",
        path: "/features/notifications/events",
        message:
          "Reservation events are only emitted when the 'reservations' feature is enabled. Enable it, or remove the reservation_* events.",
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

    return issues;
  },

  contributeEntities(): FeatureEntityContribution {
    // Notifications are stateless: delivery is attempted, retried and logged.
    // Persisting an outbox is deliberately out of scope for the alpha.
    return {};
  },

  contribute(context: FeatureContext): FeatureContribution {
    const config = notificationsConfig(context.config);

    const secrets: SecretDefinition[] = [
      {
        name: "NOTIFICATIONS_PROVIDER",
        feature: "notifications",
        description: `Delivery provider: log, resend or mock. Defaults to '${config.provider}'.`,
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

    return {
      secrets,
      infrastructure:
        config.provider === "resend"
          ? [
              {
                kind: "service",
                name: "resend",
                feature: "notifications",
                reason: "Transactional email delivery.",
                portabilityNote:
                  "Delivery is attempted inline with a bounded retry. Move it to a queue before relying on it for anything that must not be lost.",
              },
            ]
          : [],
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
    "Subscribes to domain events and sends messages through a NotificationProvider interface. Providers: log (default, development), resend (production), mock (tests). Select at runtime with NOTIFICATIONS_PROVIDER. Config: provider, from, events (any of user_registered, user_email_verification_requested, user_password_reset_requested, reservation_created, reservation_confirmed, reservation_cancelled, reservation_expired), maxAttempts. The reservation service never imports a provider; it only emits events.",

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
      config: { provider: "log", events: ["user_registered"] },
      withFeatures: { auth: {}, crud: {} },
      expectFiles: [
        "src/generated/notifications/notification-provider.ts",
        "src/generated/notifications/providers/log.provider.ts",
        "src/generated/notifications/providers/resend.provider.ts",
        "src/generated/notifications/providers/mock.provider.ts",
        "src/generated/notifications/notification.listener.ts",
        "src/generated/notifications/notification.service.spec.ts",
      ],
      expectEndpoints: [],
    },
  ],
};
