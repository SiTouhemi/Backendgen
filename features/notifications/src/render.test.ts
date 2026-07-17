import type { TargetRenderContext } from "@backend-compiler/target-sdk";
import { describe, expect, it } from "vitest";
import { notificationsRenderer } from "./render.js";

function renderForUser(
  softDelete: boolean,
  recovery = false,
  from = "no-reply@example.test",
) {
  const context = {
    config: {
      provider: "resend",
      from,
      events: ["user_registered"],
      maxAttempts: 3,
    },
    featureConfig: (name: string) =>
      name === "auth"
        ? {
            userEntity: "User",
            emailVerification: recovery,
            passwordReset: recovery,
          }
        : undefined,
    entity: (name: string) => ({ name, softDelete }),
  } as unknown as TargetRenderContext;

  return notificationsRenderer.render(context);
}

function contents(
  result: ReturnType<typeof notificationsRenderer.render>,
  path: string,
): string {
  const rendered = result.files.find((candidate) => candidate.path === path);
  if (rendered === undefined) throw new Error(`Missing rendered file ${path}`);
  return rendered.contents;
}

describe("notifications renderer", () => {
  it("generates a network-free real-database outbox integration test", () => {
    const result = renderForUser(false);
    const integration = contents(result, "test/notification-outbox.e2e-spec.ts");
    const module = contents(
      result,
      "src/generated/notifications/notification.module.ts",
    );
    const dispatcher = contents(
      result,
      "src/generated/notifications/notification.dispatcher.ts",
    );

    expect(integration).toContain("const provider = new MockNotificationProvider()");
    expect(integration).toContain("await prisma.$connect()");
    expect(integration).not.toContain("AppModule");
    expect(integration).toContain("dispatcher.dispatchOnce()");
    expect(integration).toContain("status: 'DELIVERED'");
    expect(integration).toContain("payload: null");
    expect(integration).toContain("lastError: 'unsupported-event'");
    expect(dispatcher).toContain("attempts: { increment: 1 }");
    expect(dispatcher).toContain("row.attempts >= MAX_ATTEMPTS");
    expect(dispatcher).toContain("const attempt = row.attempts;");
    expect(module).toContain("selected === 'mock' && process.env.NODE_ENV !== 'test'");
    expect(module).toContain("mock notification provider is only allowed");
  });

  it("never resolves a soft-deleted account as an outbox recipient", () => {
    const result = renderForUser(true);
    const dispatcher = contents(
      result,
      "src/generated/notifications/notification.dispatcher.ts",
    );
    const integration = contents(result, "test/notification-outbox.e2e-spec.ts");

    expect(dispatcher).toContain("findFirst({");
    expect(dispatcher).toContain("where: { id: userId, deletedAt: null }");
    expect(dispatcher).not.toContain("findUnique({\n      where: { id: userId }");
    expect(integration).toContain("recipient was soft deleted");
    expect(integration).toContain("lastError: 'recipient-not-found'");
  });

  it("requires HTTPS recovery origins in production and generates focused tests", () => {
    const result = renderForUser(false, true);
    const links = contents(result, "src/generated/notifications/recovery-links.ts");
    const spec = contents(result, "src/generated/notifications/recovery-links.spec.ts");

    expect(links).toContain("nodeEnvironment === 'production'");
    expect(links).toContain("APP_PUBLIC_URL must use HTTPS");
    expect(spec).toContain("rejects plaintext recovery links in production");
    expect(spec).toContain("http://localhost:3000', 'development'");
  });

  it("escapes configured senders and refuses a log override for recovery", () => {
    const result = renderForUser(false, true, "O'Brien <mail@example.com>");
    const module = contents(result, "src/generated/notifications/notification.module.ts");
    const provider = contents(
      result,
      "src/generated/notifications/providers/resend.provider.ts",
    );

    expect(module).toContain(`const DEFAULT_FROM = "O'Brien <mail@example.com>";`);
    expect(module).toContain("selected === 'log' && RECOVERY_DELIVERY_REQUIRED");
    expect(module).toContain("log notification provider cannot deliver account-recovery links");
    expect(provider).toContain("response.status === 408");
    expect(provider).toContain("response.status === 425");
  });
});
