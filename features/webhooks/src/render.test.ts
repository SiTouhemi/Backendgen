import type { TargetRenderContext } from "@backend-compiler/target-sdk";
import { describe, expect, it } from "vitest";
import { webhooksRenderer } from "./render.js";

function render(tenantAware: boolean) {
  const context = {
    config: { maxAttempts: 3, disableAfterFailures: 2 },
    settings: { apiPrefix: "api" },
    hasFeature: (name: string) =>
      name === "auth" || name === "crud" || (tenantAware && name === "organizations"),
    featureConfig: (name: string) => {
      if (name === "auth") {
        return { roles: ["manager", "member"], defaultRole: "member" };
      }
      if (name === "organizations" && tenantAware) {
        return { roles: ["owner", "member"], defaultRole: "member" };
      }
      return undefined;
    },
  } as unknown as TargetRenderContext;

  return webhooksRenderer.render(context);
}

function contents(
  result: ReturnType<typeof webhooksRenderer.render>,
  path: string,
): string {
  const rendered = result.files.find((candidate) => candidate.path === path);
  if (rendered === undefined) throw new Error(`Missing rendered file ${path}`);
  return rendered.contents;
}

describe("webhooks renderer", () => {
  it("generates transactional capture and leased, idempotent fan-out", () => {
    const result = render(false);
    const dispatcher = contents(
      result,
      "src/generated/webhooks/webhook-dispatcher.ts",
    );
    const paths = result.files.map((file) => file.path);

    expect(paths).toContain("src/generated/webhooks/webhook-outbox.ts");
    expect(paths).not.toContain("src/generated/webhooks/webhook-events.ts");
    expect(dispatcher).toContain("queueClaimSql(");
    expect(dispatcher).toContain("eventId: event.id");
    expect(dispatcher).toContain("skipDuplicates: true");
    expect(dispatcher).toContain("lockedUntil: event.leaseUntil");
  });

  it("pins outbound connections and signs every routing field", () => {
    const result = render(false);
    const guard = contents(result, "src/generated/webhooks/url-guard.ts");
    const dispatcher = contents(
      result,
      "src/generated/webhooks/webhook-dispatcher.ts",
    );
    const signature = contents(result, "src/generated/webhooks/signature.ts");

    expect(guard).toContain("const pinnedLookup");
    expect(guard).toContain("['fe80::', 10]");
    expect(guard).toContain("['fec0::', 10]");
    expect(guard).toContain("['64:ff9b:1::', 48]");
    expect(guard).toContain("isIP(target.address) !== target.family");
    expect(dispatcher).toContain("resolveWebhookTarget(url)");
    expect(dispatcher).toContain("status === 408 || status === 425 || status === 429");
    expect(dispatcher).toContain("postWebhook(");
    expect(signature).toContain("deliveryId");
    expect(signature).toContain("eventName");
    expect(signature).toContain("toleranceSeconds");
  });

  it("uses account administrators globally and organization administrators for tenants", () => {
    const globalController = contents(
      render(false),
      "src/generated/webhooks/webhook.controller.ts",
    );
    const tenantResult = render(true);
    const tenantController = contents(
      tenantResult,
      "src/generated/webhooks/webhook.controller.ts",
    );
    const tenantOutbox = contents(
      tenantResult,
      "src/generated/webhooks/webhook-outbox.ts",
    );

    expect(globalController).toContain('@Roles("manager")');
    expect(tenantController).toContain('@OrgRoles("owner")');
    expect(tenantOutbox).not.toContain('"user.registered"');
    expect(tenantOutbox).toContain("organizationId: string");
  });
});
