import type { DraftEntity, EndpointDefinition, EntityPatch } from "@backend-compiler/compiler";
import type {
  FeatureContext,
  FeatureContribution,
  FeatureEntityContext,
  FeatureEntityContribution,
  FeaturePack,
} from "@backend-compiler/feature-sdk";
import { TARGET_ID } from "@backend-compiler/target-nestjs-prisma";
import { organizationsRenderer } from "./render.js";

export const ORGANIZATIONS_VERSION = "0.2.0";

export interface OrganizationsConfig {
  scopedEntities?: string[];
  roles: string[];
  defaultRole?: string;
  userEntity: string;
}

export function organizationsConfig(raw: Record<string, unknown>): OrganizationsConfig {
  return raw as unknown as OrganizationsConfig;
}

export function ownerRole(config: OrganizationsConfig): string {
  return config.roles[0] ?? "owner";
}

export function memberRole(config: OrganizationsConfig): string {
  return config.defaultRole ?? config.roles[config.roles.length - 1] ?? "member";
}

/** Entities that carry an `organizationId`. Users never do: they join through Membership. */
function scopedEntities(
  config: OrganizationsConfig,
  specEntities: readonly string[],
): string[] {
  const explicit = config.scopedEntities;
  if (explicit !== undefined) {
    return [...explicit].sort();
  }
  return specEntities.filter((entity) => entity !== config.userEntity).sort();
}

export const organizationsFeature: FeaturePack = {
  name: "organizations",
  version: ORGANIZATIONS_VERSION,
  description:
    "Multi-tenant organizations with membership, organization roles, an organization request context and server-side tenant isolation on every scoped entity.",
  dependsOn: ["auth", "crud"],
  conflictsWith: [],
  supportedTargets: [TARGET_ID],

  configSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      scopedEntities: {
        type: "array",
        items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
        uniqueItems: true,
        description:
          "Entities isolated per organization. Defaults to every specification entity except the user entity.",
      },
      roles: {
        type: "array",
        items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        minItems: 1,
        uniqueItems: true,
        default: ["owner", "admin", "member"],
        description: "Organization roles, most privileged first. The first role is granted to the creator.",
      },
      defaultRole: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
      userEntity: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$", default: "User" },
    },
  },

  requiredEntities(raw): readonly string[] {
    const config = organizationsConfig(raw);
    return [config.userEntity, ...(config.scopedEntities ?? [])].sort();
  },

  validate(context: FeatureEntityContext) {
    const config = organizationsConfig(context.config);
    const issues: Array<{ code: string; path: string; message: string }> = [];

    if (config.defaultRole !== undefined && !config.roles.includes(config.defaultRole)) {
      issues.push({
        code: "feature.organizations.unknown-default-role",
        path: "/features/organizations/defaultRole",
        message: `defaultRole '${config.defaultRole}' is not one of: ${config.roles.join(", ")}`,
      });
    }

    if ((config.scopedEntities ?? []).includes(config.userEntity)) {
      issues.push({
        code: "feature.organizations.user-entity-scoped",
        path: "/features/organizations/scopedEntities",
        message:
          "The user entity cannot be organization-scoped. Users join organizations through Membership so that one account can belong to several tenants.",
      });
    }

    return issues;
  },

  contributeEntities(context: FeatureEntityContext): FeatureEntityContribution {
    const config = organizationsConfig(context.config);

    const create: DraftEntity[] = [
      {
        name: "Organization",
        description: "A tenant. Every scoped row belongs to exactly one.",
        origin: "feature",
        ownerFeature: "organizations",
        fields: [
          { name: "name", type: "string", required: true, minLength: 2, maxLength: 120 },
          {
            name: "slug",
            type: "string",
            required: true,
            unique: true,
            minLength: 2,
            maxLength: 64,
            readOnly: true,
          },
        ],
      },
      {
        name: "Membership",
        description: "Links an account to an organization with an organization role.",
        origin: "feature",
        ownerFeature: "organizations",
        fields: [
          {
            name: "role",
            type: "string",
            required: true,
            enumValues: [...config.roles],
            defaultValue: memberRole(config),
          },
        ],
        relations: [
          // A membership is a pure join row; it disappears with either side.
          {
            name: "organization",
            type: "belongsTo",
            target: "Organization",
            required: true,
            onDelete: "cascade",
          },
          {
            name: "user",
            type: "belongsTo",
            target: config.userEntity,
            required: true,
            onDelete: "cascade",
          },
        ],
        indexes: [{ fields: ["organizationId", "userId"], unique: true }],
      },
    ];

    const patch: EntityPatch[] = scopedEntities(config, context.specEntities).map((entity) => ({
      entity,
      addRelations: [
        { name: "organization", type: "belongsTo", target: "Organization", required: true },
      ],
      tenant: {
        relation: "organization",
        foreignKey: "organizationId",
        entity: "Organization",
      },
    }));

    return { create, patch };
  },

  contribute(context: FeatureContext): FeatureContribution {
    const config = organizationsConfig(context.config);
    const owner = ownerRole(config);
    const admins = config.roles.slice(0, Math.max(1, config.roles.length - 1));

    const endpoints: EndpointDefinition[] = [
      {
        id: "Organization.create",
        feature: "organizations",
        method: "POST",
        path: "/organizations",
        entity: "Organization",
        operation: "create",
        summary: "Create an organization; the caller becomes its " + owner,
        auth: "authenticated",
        roles: [],
      },
      {
        id: "Organization.list",
        feature: "organizations",
        method: "GET",
        path: "/organizations",
        entity: "Organization",
        operation: "list",
        summary: "List the organizations the caller belongs to",
        auth: "authenticated",
        roles: [],
      },
      {
        id: "Organization.read",
        feature: "organizations",
        method: "GET",
        path: "/organizations/:id",
        entity: "Organization",
        operation: "read",
        summary: "Read one organization the caller belongs to",
        auth: "authenticated",
        roles: [],
      },
      {
        id: "Membership.list",
        feature: "organizations",
        method: "GET",
        path: "/organizations/:id/members",
        entity: "Membership",
        operation: "list",
        summary: "List the members of an organization",
        auth: "authenticated",
        roles: [],
      },
      {
        id: "Membership.create",
        feature: "organizations",
        method: "POST",
        path: "/organizations/:id/members",
        entity: "Membership",
        operation: "create",
        summary: "Add a member to an organization",
        auth: "authenticated",
        roles: admins,
      },
      {
        id: "Membership.update",
        feature: "organizations",
        method: "PATCH",
        path: "/organizations/:id/members/:userId",
        entity: "Membership",
        operation: "update",
        summary: "Change a member's organization role",
        auth: "authenticated",
        roles: admins,
      },
      {
        id: "Membership.delete",
        feature: "organizations",
        method: "DELETE",
        path: "/organizations/:id/members/:userId",
        entity: "Membership",
        operation: "delete",
        summary: "Remove a member from an organization",
        auth: "authenticated",
        roles: admins,
      },
    ];

    return {
      endpoints,
      permissions: context.entities
        .filter((entity) => entity.tenant !== null)
        .flatMap((entity) =>
          (["create", "read", "list", "update", "delete"] as const).map((action) => ({
            feature: "organizations",
            entity: entity.name,
            action,
            roles: [],
            requiresOwnership: entity.ownership !== null,
            requiresTenant: true,
          })),
        ),
    };
  },

  renderers: { [TARGET_ID]: organizationsRenderer },

  agentSummary:
    "Adds Organization and Membership entities and an organizationId to every scoped entity. A global guard resolves the caller's organization from the X-Organization-Id header (or their single membership) and every generated query filters by it on the server. Options: scopedEntities, roles (most privileged first), defaultRole, userEntity.",

  examples: [
    { name: "Defaults", config: {} },
    {
      name: "Scope only billing entities",
      config: { scopedEntities: ["Invoice", "Subscription"], roles: ["owner", "member"] },
    },
  ],

  conformance: [
    {
      name: "organizations-default",
      description: "Tenant context guard, organization endpoints and an isolation test exist.",
      config: {},
      expectFiles: [
        "src/generated/organizations/organization.controller.ts",
        "src/generated/organizations/organization.service.ts",
        "src/generated/organizations/guards/organization-context.guard.ts",
        "test/tenant-isolation.e2e-spec.ts",
      ],
      expectEndpoints: ["Organization.create", "Organization.list", "Membership.create"],
    },
  ],
};
