import type { DraftEntity, DraftRelation } from "@backend-compiler/compiler";
import type {
  FeatureContext,
  FeatureContribution,
  FeatureEntityContext,
  FeatureEntityContribution,
  FeaturePack,
} from "@backend-compiler/feature-sdk";
import { TARGET_ID } from "@backend-compiler/target-nestjs-prisma";
import { webhooksRenderer } from "./render.js";

export const WEBHOOKS_VERSION = "0.2.0";

/**
 * Events an endpoint may subscribe to. Recovery events are deliberately not
 * listed: their payloads carry single-use credentials and must never leave the
 * system through a webhook.
 */
export const WEBHOOK_EVENT_CATALOG = [
  "user.registered",
  "reservation.created",
  "reservation.confirmed",
  "reservation.cancelled",
  "reservation.expired",
] as const;

export interface WebhooksConfig {
  maxAttempts: number;
  disableAfterFailures: number;
}

export function webhooksConfig(raw: Record<string, unknown>): WebhooksConfig {
  return raw as unknown as WebhooksConfig;
}

const QUEUE_FIELDS: DraftEntity["fields"] = [
  { name: "eventName", type: "string", required: true, internal: true },
  {
    name: "payload",
    type: "text",
    required: false,
    internal: true,
    description: "JSON payload. Cleared when the row reaches a terminal state.",
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
  { name: "lockedUntil", type: "datetime", required: false, internal: true },
  { name: "lastError", type: "string", required: false, internal: true },
];

export const webhooksFeature: FeaturePack = {
  name: "webhooks",
  version: WEBHOOKS_VERSION,
  description:
    "Outbound webhooks: administrator-managed endpoints, transactional event capture, leased fan-out and delivery, versioned HMAC signatures, persisted retries, auto-disable on repeated failure, and SSRF-guarded destinations.",
  dependsOn: ["auth", "crud"],
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
        description: "Delivery attempts per endpoint before a delivery is marked FAILED.",
      },
      disableAfterFailures: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 10,
        description: "Consecutive terminal failures after which an endpoint is disabled.",
      },
    },
  },

  requiredEntities(): readonly string[] {
    return [];
  },

  validate(context) {
    const issues: Array<{ code: string; path: string; message: string }> = [];
    const auth = context.featureConfig("auth") as
      | { roles?: string[]; defaultRole?: string }
      | undefined;
    const accountRoles = auth?.roles ?? ["admin", "user"];
    const accountDefault = auth?.defaultRole ?? accountRoles.at(-1) ?? "user";
    if (accountRoles.every((role) => role === accountDefault)) {
      issues.push({
        code: "feature.webhooks.no-safe-account-admin-role",
        path: "/features/auth/roles",
        message:
          "Webhooks need an account administrator role distinct from the self-registration role.",
      });
    }

    const organizations = context.featureConfig("organizations") as
      | { roles?: string[]; defaultRole?: string }
      | undefined;
    if (organizations !== undefined) {
      const organizationRoles = organizations.roles ?? ["owner", "admin", "member"];
      const memberDefault =
        organizations.defaultRole ?? organizationRoles.at(-1) ?? "member";
      if (organizationRoles.every((role) => role === memberDefault)) {
        issues.push({
          code: "feature.webhooks.no-safe-organization-admin-role",
          path: "/features/organizations/roles",
          message:
            "Tenant webhooks need an organization administrator role distinct from the default member role.",
        });
      }
    }

    return issues;
  },

  contributeEntities(context: FeatureEntityContext): FeatureEntityContribution {
    const tenantAware = context.featureConfig("organizations") !== undefined;

    const endpointRelations: DraftRelation[] = tenantAware
      ? [
          {
            name: "organization",
            type: "belongsTo",
            target: "Organization",
            required: true,
            onDelete: "cascade",
          },
        ]
      : [];

    const endpoint: DraftEntity = {
      name: "WebhookEndpoint",
      description: "A consumer-registered webhook destination.",
      origin: "feature",
      ownerFeature: "webhooks",
      fields: [
        { name: "url", type: "string", required: true, maxLength: 2000 },
        {
          name: "events",
          type: "text",
          required: true,
          internal: true,
          description: "JSON array of subscribed event names.",
        },
        {
          name: "secret",
          type: "string",
          required: true,
          internal: true,
          description:
            "HMAC signing key. Returned exactly once at creation; signing requires the raw value, so it is stored (never exposed) rather than hashed.",
        },
        { name: "active", type: "boolean", required: true, defaultValue: true },
        {
          name: "consecutiveFailures",
          type: "integer",
          required: true,
          defaultValue: 0,
          internal: true,
        },
      ],
      relations: endpointRelations,
    };

    if (tenantAware) {
      endpoint.tenant = {
        relation: "organization",
        foreignKey: "organizationId",
        entity: "Organization",
      };
    }

    const eventRelations: DraftRelation[] = tenantAware
      ? [
          {
            name: "organization",
            type: "belongsTo",
            target: "Organization",
            required: true,
            onDelete: "cascade",
          },
        ]
      : [];

    const event: DraftEntity = {
      name: "WebhookEvent",
      description:
        "Transactionally captured domain event awaiting fan-out to subscribed endpoints.",
      origin: "feature",
      ownerFeature: "webhooks",
      fields: [...QUEUE_FIELDS],
      relations: eventRelations,
      indexes: [{ fields: ["status", "nextAttemptAt"], unique: false }],
    };

    if (tenantAware) {
      event.tenant = {
        relation: "organization",
        foreignKey: "organizationId",
        entity: "Organization",
      };
    }

    const delivery: DraftEntity = {
      name: "WebhookDelivery",
      description: "One delivery attempt chain of one event to one endpoint.",
      origin: "feature",
      ownerFeature: "webhooks",
      fields: [
        ...QUEUE_FIELDS,
        { name: "responseStatus", type: "integer", required: false, internal: true },
      ],
      relations: [
        {
          name: "endpoint",
          type: "belongsTo",
          target: "WebhookEndpoint",
          required: true,
          onDelete: "cascade",
        },
        {
          name: "event",
          type: "belongsTo",
          target: "WebhookEvent",
          required: true,
          onDelete: "cascade",
        },
      ],
      indexes: [
        { fields: ["status", "nextAttemptAt"], unique: false },
        { fields: ["eventId", "endpointId"], unique: true },
      ],
    };

    return { create: [endpoint, event, delivery] };
  },

  contribute(context: FeatureContext): FeatureContribution {
    const auth = context.featureConfig("auth") as
      | { roles?: string[]; defaultRole?: string }
      | undefined;
    const tenantAware = context.featureConfig("organizations") !== undefined;
    const roles = auth?.roles ?? ["admin", "user"];
    const registrationRole = auth?.defaultRole ?? roles.at(-1) ?? "user";
    const managementRoles = tenantAware
      ? []
      : roles.filter((role) => role !== registrationRole).slice(0, 1);

    return {
      endpoints: [
        {
          id: "WebhookEndpoint.create",
          feature: "webhooks",
          method: "POST",
          path: "/webhooks",
          entity: "WebhookEndpoint",
          operation: "create",
          summary: "Register a webhook endpoint; the signing secret is returned exactly once",
          auth: "authenticated",
          roles: managementRoles,
        },
        {
          id: "WebhookEndpoint.list",
          feature: "webhooks",
          method: "GET",
          path: "/webhooks",
          entity: "WebhookEndpoint",
          operation: "list",
          summary: "List registered webhook endpoints",
          auth: "authenticated",
          roles: managementRoles,
        },
        {
          id: "WebhookEndpoint.delete",
          feature: "webhooks",
          method: "DELETE",
          path: "/webhooks/:id",
          entity: "WebhookEndpoint",
          operation: "delete",
          summary: "Remove a webhook endpoint",
          auth: "authenticated",
          roles: managementRoles,
        },
      ],
      infrastructure: [
        {
          kind: "scheduler",
          name: "webhook-dispatcher",
          feature: "webhooks",
          reason:
            "Fans captured events out to subscribed endpoints and delivers with leased, per-endpoint retries.",
          portabilityNote: "PostgreSQL row locking (FOR UPDATE SKIP LOCKED).",
        },
      ],
      customizationPoints: [],
    };
  },

  renderers: { [TARGET_ID]: webhooksRenderer },

  agentSummary:
    "Outbound webhooks. Account administrators manage global endpoints; organization administrators manage tenant endpoints. Domain transactions enqueue events, replicas lease fan-out and delivery work, and each POST carries a versioned HMAC over its signed delivery id, event, timestamp and body. Consumers must reject stale timestamps and deduplicate the signed delivery id. Destinations are HTTPS-only in production, resolve only to allowed public addresses, and connect to the validated address to prevent DNS rebinding. Recovery-token events are never deliverable.",

  examples: [{ name: "Defaults", config: {} }],

  conformance: [
    {
      name: "webhooks-default",
      description: "Endpoint management, URL guard, dispatcher and signature helper exist.",
      config: {},
      withFeatures: {
        crud: {},
        auth: { emailVerification: false, passwordReset: false },
      },
      expectFiles: [
        "src/generated/webhooks/webhook.controller.ts",
        "src/generated/webhooks/webhook.service.ts",
        "src/generated/webhooks/webhook-dispatcher.ts",
        "src/generated/webhooks/url-guard.ts",
        "src/generated/webhooks/webhook-outbox.ts",
        "src/generated/webhooks/webhooks.module.ts",
      ],
      expectEndpoints: ["WebhookEndpoint.create", "WebhookEndpoint.list", "WebhookEndpoint.delete"],
    },
  ],
};
