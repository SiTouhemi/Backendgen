export interface AuthConfig {
  userEntity: string;
  methods: string[];
  roles: string[];
  defaultRole?: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  emailVerification: boolean;
  passwordReset: boolean;
  minPasswordLength: number;
  rateLimit: { ttlSeconds: number; limit: number };
}

export function authConfig(raw: Record<string, unknown>): AuthConfig {
  return raw as unknown as AuthConfig;
}

/**
 * Roles are listed most-privileged first, so the least-privileged role is the
 * safe default for a self-registered account. An explicit `defaultRole` always
 * wins.
 */
export function defaultRole(config: AuthConfig): string {
  return config.defaultRole ?? config.roles[config.roles.length - 1] ?? "user";
}

export const AUTH_CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    userEntity: {
      type: "string",
      pattern: "^[A-Za-z][A-Za-z0-9_]*$",
      default: "User",
      description: "Entity that stores accounts. It is extended with passwordHash, role and email verification fields.",
    },
    methods: {
      type: "array",
      items: { enum: ["email_password"] },
      minItems: 1,
      uniqueItems: true,
      default: ["email_password"],
    },
    roles: {
      type: "array",
      items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
      minItems: 1,
      uniqueItems: true,
      default: ["admin", "user"],
      description: "Roles, most privileged first. The last role is the default for new accounts.",
    },
    defaultRole: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
    accessTokenTtlSeconds: { type: "integer", minimum: 60, maximum: 3600, default: 900 },
    refreshTokenTtlDays: { type: "integer", minimum: 1, maximum: 365, default: 30 },
    emailVerification: { type: "boolean", default: true },
    passwordReset: { type: "boolean", default: true },
    // bcrypt rejects/truncates beyond 72 bytes, so generated DTO policy must
    // never demand a minimum that its password service cannot safely accept.
    minPasswordLength: { type: "integer", minimum: 8, maximum: 72, default: 12 },
    rateLimit: {
      type: "object",
      additionalProperties: false,
      default: { ttlSeconds: 60, limit: 10 },
      properties: {
        ttlSeconds: { type: "integer", minimum: 1, default: 60 },
        limit: { type: "integer", minimum: 1, default: 10 },
      },
    },
  },
} as const;
