import type {
  DraftEntity,
  EndpointDefinition,
  EventDefinition,
  SecretDefinition,
} from "@backend-compiler/compiler";
import type {
  FeatureContext,
  FeatureContribution,
  FeatureEntityContext,
  FeatureEntityContribution,
  FeaturePack,
} from "@backend-compiler/feature-sdk";
import { TARGET_ID } from "@backend-compiler/target-nestjs-prisma";
import { AUTH_CONFIG_SCHEMA, authConfig, defaultRole } from "./config.js";
import { authRenderer } from "./render.js";

export const AUTH_VERSION = "0.2.0";

function tokenEntity(name: string, userEntity: string, purpose: string): DraftEntity {
  return {
    name,
    description: purpose,
    origin: "feature",
    ownerFeature: "auth",
    fields: [
      {
        name: "tokenHash",
        type: "string",
        required: true,
        unique: true,
        internal: true,
        description: "SHA-256 digest of the opaque token. The token itself is never stored.",
      },
      { name: "expiresAt", type: "datetime", required: true },
      { name: "consumedAt", type: "datetime", required: false },
    ],
    relations: [{ name: "user", type: "belongsTo", target: userEntity, required: true }],
  };
}

export const authFeature: FeaturePack = {
  name: "auth",
  version: AUTH_VERSION,
  description:
    "Email and password authentication: registration, login, short-lived access tokens, rotating refresh sessions, logout, roles, route guards, email verification and password reset foundations.",
  dependsOn: ["crud"],
  conflictsWith: [],
  supportedTargets: [TARGET_ID],
  configSchema: AUTH_CONFIG_SCHEMA as unknown as Record<string, unknown>,

  requiredEntities(raw): readonly string[] {
    return [authConfig(raw).userEntity];
  },

  validate(context: FeatureEntityContext) {
    const config = authConfig(context.config);
    const issues: Array<{ code: string; path: string; message: string }> = [];

    if (config.defaultRole !== undefined && !config.roles.includes(config.defaultRole)) {
      issues.push({
        code: "feature.auth.unknown-default-role",
        path: "/features/auth/defaultRole",
        message: `defaultRole '${config.defaultRole}' is not one of the declared roles: ${config.roles.join(", ")}`,
      });
    }

    return issues;
  },

  contributeEntities(context: FeatureEntityContext): FeatureEntityContribution {
    const config = authConfig(context.config);
    const user = config.userEntity;

    const create: DraftEntity[] = [
      {
        name: "RefreshSession",
        description: "Server-managed refresh session. Rotated on every use.",
        origin: "feature",
        ownerFeature: "auth",
        fields: [
          {
            name: "tokenHash",
            type: "string",
            required: true,
            unique: true,
            internal: true,
            description: "SHA-256 digest of the opaque refresh token.",
          },
          { name: "expiresAt", type: "datetime", required: true },
          { name: "revokedAt", type: "datetime", required: false },
          {
            name: "replacedByHash",
            type: "string",
            required: false,
            internal: true,
            description: "Digest of the session that superseded this one, for reuse detection.",
          },
        ],
        relations: [{ name: "user", type: "belongsTo", target: user, required: true }],
        indexes: [{ fields: ["expiresAt"], unique: false }],
      },
    ];

    if (config.emailVerification) {
      create.push(tokenEntity("EmailVerificationToken", user, "Single-use email verification token."));
    }

    if (config.passwordReset) {
      create.push(tokenEntity("PasswordResetToken", user, "Single-use password reset token."));
    }

    return {
      create,
      patch: [
        {
          entity: user,
          // Accounts are managed by the auth endpoints, not by generic CRUD.
          crud: false,
          addFields: [
            {
              name: "email",
              type: "string",
              required: true,
              unique: true,
              maxLength: 254,
              description: "Login identifier.",
            },
            {
              name: "passwordHash",
              type: "string",
              required: true,
              internal: true,
              description: "bcrypt hash. Never returned by the API.",
            },
            {
              name: "role",
              type: "string",
              required: true,
              enumValues: [...config.roles],
              defaultValue: defaultRole(config),
              readOnly: true,
            },
            {
              name: "emailVerifiedAt",
              type: "datetime",
              required: false,
              readOnly: true,
            },
          ],
        },
      ],
    };
  },

  contribute(context: FeatureContext): FeatureContribution {
    const config = authConfig(context.config);

    const endpoints: EndpointDefinition[] = [
      {
        id: "auth.register",
        feature: "auth",
        method: "POST",
        path: "/auth/register",
        entity: config.userEntity,
        operation: "register",
        summary: "Create an account and return a token pair",
        auth: "public",
        roles: [],
      },
      {
        id: "auth.login",
        feature: "auth",
        method: "POST",
        path: "/auth/login",
        entity: config.userEntity,
        operation: "login",
        summary: "Exchange email and password for a token pair",
        auth: "public",
        roles: [],
      },
      {
        id: "auth.refresh",
        feature: "auth",
        method: "POST",
        path: "/auth/refresh",
        entity: null,
        operation: "refresh",
        summary: "Rotate a refresh token and return a new token pair",
        auth: "public",
        roles: [],
      },
      {
        id: "auth.logout",
        feature: "auth",
        method: "POST",
        path: "/auth/logout",
        entity: null,
        operation: "logout",
        summary: "Revoke the current refresh session",
        auth: "authenticated",
        roles: [],
      },
      {
        id: "auth.me",
        feature: "auth",
        method: "GET",
        path: "/auth/me",
        entity: config.userEntity,
        operation: "me",
        summary: "Return the authenticated account",
        auth: "authenticated",
        roles: [],
      },
    ];

    const events: EventDefinition[] = [
      {
        name: "user.registered",
        feature: "auth",
        description: "Emitted after a successful registration.",
        payload: { userId: "uuid", email: "string" },
      },
    ];

    if (config.emailVerification) {
      endpoints.push(
        {
          id: "auth.request-email-verification",
          feature: "auth",
          method: "POST",
          path: "/auth/request-email-verification",
          entity: null,
          operation: "request-email-verification",
          summary: "Issue a new email verification token",
          auth: "authenticated",
          roles: [],
        },
        {
          id: "auth.verify-email",
          feature: "auth",
          method: "POST",
          path: "/auth/verify-email",
          entity: null,
          operation: "verify-email",
          summary: "Consume an email verification token",
          auth: "public",
          roles: [],
        },
      );

      events.push({
        name: "user.email_verification_requested",
        feature: "auth",
        description:
          "Carries the single-use verification token so a delivery feature can send it. The token is not persisted in clear text.",
        payload: { userId: "uuid", email: "string", token: "string" },
      });
    }

    if (config.passwordReset) {
      endpoints.push(
        {
          id: "auth.request-password-reset",
          feature: "auth",
          method: "POST",
          path: "/auth/request-password-reset",
          entity: null,
          operation: "request-password-reset",
          summary: "Issue a password reset token",
          auth: "public",
          roles: [],
        },
        {
          id: "auth.reset-password",
          feature: "auth",
          method: "POST",
          path: "/auth/reset-password",
          entity: null,
          operation: "reset-password",
          summary: "Consume a reset token and set a new password",
          auth: "public",
          roles: [],
        },
      );

      events.push({
        name: "user.password_reset_requested",
        feature: "auth",
        description: "Carries the single-use reset token so a delivery feature can send it.",
        payload: { userId: "uuid", email: "string", token: "string" },
      });
    }

    const secrets: SecretDefinition[] = [
      {
        name: "JWT_ACCESS_SECRET",
        feature: "auth",
        description:
          "HMAC key for access tokens. At least 32 characters. The application refuses to start without it.",
        required: true,
        example: "replace-with-a-random-32-plus-character-secret",
      },
    ];

    return {
      endpoints,
      events,
      secrets,
      infrastructure: [
        {
          kind: "service",
          name: "rate-limiter",
          feature: "auth",
          reason: `In-memory throttling of authentication routes (${config.rateLimit.limit} requests per ${config.rateLimit.ttlSeconds}s).`,
          portabilityNote:
            "The default throttler stores counters in process memory. Replace the storage with Redis before running more than one instance.",
        },
      ],
    };
  },

  renderers: { [TARGET_ID]: authRenderer },

  agentSummary:
    "Email/password auth on the configured userEntity. Adds email, passwordHash, role and emailVerifiedAt to that entity and removes it from the generic CRUD surface. Endpoints: register, login, refresh (rotating), logout, me, and optional email-verification and password-reset. Roles are listed most-privileged first; the last role is the default for new accounts. Requires JWT_ACCESS_SECRET.",

  examples: [
    { name: "Defaults", config: {} },
    {
      name: "Hotel roles",
      config: { roles: ["admin", "customer"], accessTokenTtlSeconds: 900, refreshTokenTtlDays: 30 },
    },
  ],

  conformance: [
    {
      name: "auth-default",
      description: "Registration, login and rotation endpoints exist and are covered by tests.",
      config: {},
      expectFiles: [
        "src/generated/auth/auth.controller.ts",
        "src/generated/auth/auth.service.ts",
        "src/generated/auth/token.service.ts",
        "src/generated/auth/password.service.ts",
        "src/generated/auth/guards/jwt-auth.guard.ts",
        "src/generated/auth/guards/roles.guard.ts",
        "test/auth.e2e-spec.ts",
      ],
      expectEndpoints: ["auth.register", "auth.login", "auth.refresh", "auth.logout", "auth.me"],
    },
  ],
};
