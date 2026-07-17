import { describe, expect, it } from "vitest";
import { webhooksFeature } from "./feature.js";

function context(
  overrides: Record<string, Record<string, unknown>> = {},
) {
  return {
    featureName: "webhooks",
    config: { maxAttempts: 5, disableAfterFailures: 10 },
    target: { id: "nestjs-prisma", database: "postgresql" as const },
    specEntities: ["User", "Note"],
    featureConfig: (name: string) => {
      if (name === "auth") {
        return overrides.auth ?? {
          roles: ["admin", "member"],
          defaultRole: "member",
        };
      }
      return overrides[name];
    },
  };
}

describe("webhooks feature", () => {
  it("creates an idempotent event-to-endpoint delivery key", () => {
    const contribution = webhooksFeature.contributeEntities(context());
    const delivery = contribution.create?.find(
      (entity) => entity.name === "WebhookDelivery",
    );

    expect(delivery?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "endpoint", onDelete: "cascade" }),
        expect.objectContaining({ name: "event", onDelete: "cascade" }),
      ]),
    );
    expect(delivery?.indexes).toContainEqual({
      fields: ["eventId", "endpointId"],
      unique: true,
    });
  });

  it("requires a separate administrator role for global management", () => {
    const issues =
      webhooksFeature.validate?.(
        context({
          auth: { roles: ["member"], defaultRole: "member" },
        }),
      ) ?? [];

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "feature.webhooks.no-safe-account-admin-role",
      }),
    );
  });

  it("makes tenant events require an organization instead of allowing null scope", () => {
    const contribution = webhooksFeature.contributeEntities(
      context({
        organizations: {
          roles: ["owner", "member"],
          defaultRole: "member",
        },
      }),
    );
    const event = contribution.create?.find(
      (entity) => entity.name === "WebhookEvent",
    );

    expect(event?.tenant).toEqual({
      relation: "organization",
      foreignKey: "organizationId",
      entity: "Organization",
    });
    expect(event?.relations).toContainEqual(
      expect.objectContaining({
        name: "organization",
        required: true,
      }),
    );
  });
});
