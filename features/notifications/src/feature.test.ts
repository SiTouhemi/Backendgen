import { describe, expect, it } from "vitest";
import {
  effectiveEvents,
  notificationsFeature,
  outboxEvents,
  recoveryEvents,
  type NotificationsConfig,
} from "./feature.js";

const base: NotificationsConfig = {
  provider: "log",
  from: "no-reply@example.test",
  events: [],
  maxAttempts: 3,
};

describe("notification event resolution", () => {
  function validateRecoveryProvider(
    provider: NotificationsConfig["provider"],
    auth: Record<string, unknown>,
  ) {
    return notificationsFeature.validate?.({
      featureName: "notifications",
      config: { ...base, provider } as unknown as Record<string, unknown>,
      target: { id: "nestjs-prisma", database: "postgresql" },
      specEntities: ["User"],
      featureConfig: (name) => (name === "auth" ? auth : undefined),
    }) ?? [];
  }

  it("automatically enables both recovery deliveries when auth uses its defaults", () => {
    expect(recoveryEvents({})).toEqual([
      "user_email_verification_requested",
      "user_password_reset_requested",
    ]);
    expect(effectiveEvents(base, {})).toEqual([
      "user_email_verification_requested",
      "user_password_reset_requested",
    ]);
  });

  it("respects disabled recovery flows and de-duplicates explicitly listed events", () => {
    expect(
      effectiveEvents(
        { ...base, events: ["user_email_verification_requested"] },
        { emailVerification: true, passwordReset: false },
      ),
    ).toEqual(["user_email_verification_requested"]);
  });

  it("keeps every credential-bearing recovery event out of the durable outbox", () => {
    expect(
      outboxEvents(
        {
          ...base,
          events: [
            "user_registered",
            "user_email_verification_requested",
            "user_password_reset_requested",
          ],
        },
        { emailVerification: false, passwordReset: false },
      ),
    ).toEqual(["user_registered"]);
  });

  it("omits the outbox entity when only credential-bearing recovery events are active", () => {
    const contribution = notificationsFeature.contributeEntities({
      featureName: "notifications",
      config: base as unknown as Record<string, unknown>,
      target: { id: "nestjs-prisma", database: "postgresql" },
      specEntities: ["User"],
      featureConfig: (name) => (name === "auth" ? {} : undefined),
    });

    expect(contribution).toEqual({});
  });

  it("creates an internal non-CRUD outbox when a durable event is subscribed", () => {
    const contribution = notificationsFeature.contributeEntities({
      featureName: "notifications",
      config: {
        ...base,
        events: ["user_registered"],
      } as unknown as Record<string, unknown>,
      target: { id: "nestjs-prisma", database: "postgresql" },
      specEntities: ["User"],
      featureConfig: (name) => (name === "auth" ? {} : undefined),
    });

    expect(contribution.create).toEqual([
      expect.objectContaining({ name: "NotificationOutbox", crud: false }),
    ]);
  });

  it("rejects the non-delivering log provider when auth recovery is enabled", () => {
    expect(validateRecoveryProvider("log", {})).toContainEqual(
      expect.objectContaining({
        code: "feature.notifications.recovery-provider-nondelivering",
        path: "/features/notifications/provider",
      }),
    );
  });

  it("accepts delivering resend and custom providers for auth recovery", () => {
    expect(validateRecoveryProvider("resend", {})).toEqual([]);
    expect(validateRecoveryProvider("custom", {})).toEqual([]);
  });

  it("allows metadata-only logging when both recovery flows are disabled", () => {
    expect(
      validateRecoveryProvider("log", {
        emailVerification: false,
        passwordReset: false,
      }),
    ).toEqual([]);
  });

  it("accepts a display-name sender and rejects malformed or injectable senders", () => {
    const validateFrom = (from: string) =>
      notificationsFeature.validate?.({
        featureName: "notifications",
        config: { ...base, provider: "resend", from } as unknown as Record<string, unknown>,
        target: { id: "nestjs-prisma", database: "postgresql" },
        specEntities: ["User"],
        featureConfig: (name) =>
          name === "auth" ? { emailVerification: false, passwordReset: false } : undefined,
      }) ?? [];

    expect(validateFrom("O'Brien <mail@example.com>")).toEqual([]);
    for (const from of ["not-an-address", "sender@example.com\r\nBcc: victim@example.com"]) {
      expect(validateFrom(from)).toContainEqual(
        expect.objectContaining({ code: "feature.notifications.invalid-from" }),
      );
    }
  });

  it("rejects reservation-expired delivery when reservations have no holds", () => {
    const issues = notificationsFeature.validate?.({
      featureName: "notifications",
      config: {
        ...base,
        events: ["reservation_expired"],
      } as unknown as Record<string, unknown>,
      target: { id: "nestjs-prisma", database: "postgresql" },
      specEntities: ["User", "Appointment", "Practitioner"],
      featureConfig: (name) => {
        if (name === "auth") {
          return { emailVerification: false, passwordReset: false };
        }
        if (name === "reservations") return { holdMinutes: 0 };
        return undefined;
      },
    }) ?? [];

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "feature.notifications.reservation-expired-without-holds",
        path: "/features/notifications/events",
      }),
    );
  });
});
