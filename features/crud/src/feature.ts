import { pluralize, kebabCase } from "@backend-compiler/common";
import type { EndpointDefinition, EntityPatch, PermissionRule } from "@backend-compiler/compiler";
import type {
  FeatureContext,
  FeatureContribution,
  FeatureEntityContext,
  FeatureEntityContribution,
  FeaturePack,
} from "@backend-compiler/feature-sdk";
import { TARGET_ID } from "@backend-compiler/target-nestjs-prisma";
import { crudRenderer } from "./render.js";

export const CRUD_VERSION = "0.2.0";

interface CrudConfig {
  entities?: string[];
  softDelete: string[];
  ownedBy: Record<string, string>;
  adminRoles?: string[];
  destructiveRoles?: string[];
  destructiveOrgRoles?: string[];
  defaultPageSize: number;
  maxPageSize: number;
}

function config(raw: Record<string, unknown>): CrudConfig {
  return raw as unknown as CrudConfig;
}

function selectedEntities(raw: Record<string, unknown>, specEntities: readonly string[]): string[] {
  const parsed = config(raw);
  return [...(parsed.entities ?? specEntities)].sort();
}

function route(entity: string): string {
  return `/${pluralize(kebabCase(entity))}`;
}

export const crudFeature: FeaturePack = {
  name: "crud",
  version: CRUD_VERSION,
  description:
    "Create, read, list, update and delete endpoints with pagination, filtering, sorting, optional soft delete and optional per-row ownership scoping.",
  dependsOn: [],
  conflictsWith: [],
  supportedTargets: [TARGET_ID],

  configSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      entities: {
        type: "array",
        items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
        uniqueItems: true,
        description: "Entities to expose. Defaults to every entity in the specification.",
      },
      softDelete: {
        type: "array",
        items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
        uniqueItems: true,
        default: [],
        description: "Entities whose delete operation sets `deletedAt` instead of removing the row.",
      },
      ownedBy: {
        type: "object",
        propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
        additionalProperties: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
        default: {},
        description:
          "Entity to owner-entity map. Rows are readable and writable only by their owner, or by an admin role.",
      },
      adminRoles: {
        type: "array",
        items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        minItems: 1,
        uniqueItems: true,
        description:
          "Roles that bypass ownership scoping. Defaults to the first declared auth role that is not the self-registration role.",
      },
      destructiveRoles: {
        type: "array",
        items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        minItems: 1,
        uniqueItems: true,
        description:
          "Account roles allowed to delete entities that have no row ownership. Defaults to adminRoles.",
      },
      destructiveOrgRoles: {
        type: "array",
        items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        minItems: 1,
        uniqueItems: true,
        description:
          "Organization roles allowed to delete tenant-scoped entities. Defaults to every organization role except the least privileged.",
      },
      defaultPageSize: { type: "integer", minimum: 1, maximum: 200, default: 20 },
      maxPageSize: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    },
  },

  requiredEntities(raw): readonly string[] {
    const parsed = config(raw);
    return [...(parsed.entities ?? []), ...Object.values(parsed.ownedBy ?? {})].sort();
  },

  validate(context: FeatureEntityContext) {
    const parsed = config(context.config);
    const issues: Array<{ code: string; path: string; message: string }> = [];

    if (Object.keys(parsed.ownedBy ?? {}).length > 0 && !context.featureConfig("auth")) {
      issues.push({
        code: "feature.crud.ownership-requires-auth",
        path: "/features/crud/ownedBy",
        message: "Ownership scoping needs an authenticated caller. Enable the 'auth' feature.",
      });
    }

    if (parsed.defaultPageSize > parsed.maxPageSize) {
      issues.push({
        code: "feature.crud.invalid-page-size",
        path: "/features/crud/defaultPageSize",
        message: "defaultPageSize cannot be greater than maxPageSize",
      });
    }

    const auth = context.featureConfig("auth") as { roles?: string[] } | undefined;
    const organizations = context.featureConfig("organizations") as
      | { roles?: string[] }
      | undefined;

    if (parsed.destructiveRoles !== undefined && auth === undefined) {
      issues.push({
        code: "feature.crud.destructive-roles-require-auth",
        path: "/features/crud/destructiveRoles",
        message: "destructiveRoles requires the 'auth' feature.",
      });
    }

    if (auth !== undefined) {
      const authConfig = auth as { roles?: string[]; userEntity?: string; defaultRole?: string };
      const userEntity = authConfig.userEntity ?? "User";
      for (const [entity, owner] of Object.entries(parsed.ownedBy ?? {})) {
        if (owner !== userEntity) {
          issues.push({
            code: "feature.crud.unsupported-owner-entity",
            path: `/features/crud/ownedBy/${entity}`,
            message:
              `CRUD ownership is derived from the authenticated user id, so '${entity}' must be owned by auth.userEntity '${userEntity}', not '${owner}'. Custom owner mapping is not supported yet.`,
          });
        }
      }

      const declaredRoles = auth.roles ?? ["admin", "user"];
      const registrationRole = authConfig.defaultRole ?? declaredRoles.at(-1) ?? "user";
      const derivedAdminRoles = declaredRoles.filter((role) => role !== registrationRole).slice(0, 1);
      const effectiveAdminRoles = parsed.adminRoles ?? derivedAdminRoles;
      const effectiveDestructiveRoles = parsed.destructiveRoles ?? effectiveAdminRoles;

      if (effectiveAdminRoles.length === 0) {
        issues.push({
          code: "feature.crud.no-safe-admin-role",
          path: "/features/crud/adminRoles",
          message:
            "CRUD needs at least one privileged auth role distinct from the self-registration role. Declare another auth role or set a safe adminRoles policy.",
        });
      }

      // destructiveRoles inherits adminRoles when unset; re-validating the
      // inherited copy would just duplicate every adminRoles issue.
      const rolePolicies: Array<readonly [string, readonly string[]]> = [
        ["adminRoles", effectiveAdminRoles] as const,
        ...(parsed.destructiveRoles !== undefined
          ? [["destructiveRoles", effectiveDestructiveRoles] as const]
          : []),
      ];

      for (const [field, roles] of rolePolicies) {
        for (const [index, role] of roles.entries()) {
          if (!declaredRoles.includes(role)) {
            issues.push({
              code: "feature.crud.unknown-destructive-role",
              path: `/features/crud/${field}/${index}`,
              message: `Privileged account role '${role}' is not declared by auth. Expected one of: ${declaredRoles.join(", ")}`,
            });
          } else if (role === registrationRole) {
            issues.push({
              code: "feature.crud.self-registration-admin-role",
              path: `/features/crud/${field}/${index}`,
              message: `Role '${role}' is assigned during self-registration and cannot bypass ownership or authorize destructive operations.`,
            });
          }
        }
      }
    }

    if (parsed.destructiveOrgRoles !== undefined && organizations === undefined) {
      issues.push({
        code: "feature.crud.destructive-org-roles-require-organizations",
        path: "/features/crud/destructiveOrgRoles",
        message: "destructiveOrgRoles requires the 'organizations' feature.",
      });
    }

    if (organizations !== undefined && parsed.destructiveOrgRoles !== undefined) {
      const declaredRoles = organizations.roles ?? ["owner", "admin", "member"];
      for (const [index, role] of parsed.destructiveOrgRoles.entries()) {
        if (!declaredRoles.includes(role)) {
          issues.push({
            code: "feature.crud.unknown-destructive-org-role",
            path: `/features/crud/destructiveOrgRoles/${index}`,
            message: `Destructive organization role '${role}' is not declared by organizations. Expected one of: ${declaredRoles.join(", ")}`,
          });
        }
      }
    }

    for (const entity of parsed.softDelete ?? []) {
      if (!context.specEntities.includes(entity)) {
        issues.push({
          code: "feature.crud.unknown-entity",
          path: "/features/crud/softDelete",
          message: `Soft delete refers to unknown entity '${entity}'`,
        });
      }
    }

    return issues;
  },

  contributeEntities(context: FeatureEntityContext): FeatureEntityContribution {
    const parsed = config(context.config);
    const entities = selectedEntities(context.config, context.specEntities);
    const patch: EntityPatch[] = [];

    for (const entity of entities) {
      const owner = parsed.ownedBy?.[entity];
      const entityPatch: EntityPatch = {
        entity,
        crud: true,
        softDelete: (parsed.softDelete ?? []).includes(entity),
      };

      if (owner) {
        entityPatch.addRelations = [
          { name: "owner", type: "belongsTo", target: owner, required: true },
        ];
        entityPatch.ownership = { relation: "owner", foreignKey: "ownerId", entity: owner };
      }

      patch.push(entityPatch);
    }

    return { patch };
  },

  contribute(context: FeatureContext): FeatureContribution {
    const parsed = config(context.config);
    const auth = context.featureConfig("auth") as
      | { roles?: string[]; defaultRole?: string }
      | undefined;
    const authenticated = auth !== undefined;
    const accountRoles = auth?.roles ?? ["admin", "user"];
    const registrationRole = auth?.defaultRole ?? accountRoles.at(-1) ?? "user";
    const adminRoles =
      parsed.adminRoles ?? accountRoles.filter((role) => role !== registrationRole).slice(0, 1);
    const endpoints: EndpointDefinition[] = [];
    const permissions: PermissionRule[] = [];

    for (const entity of context.crudEntities()) {
      const base = route(entity.name);
      const operations: Array<{
        operation: PermissionRule["action"];
        method: EndpointDefinition["method"];
        path: string;
        summary: string;
      }> = [
        { operation: "list", method: "GET", path: base, summary: `List ${entity.name} records` },
        { operation: "read", method: "GET", path: `${base}/:id`, summary: `Read one ${entity.name}` },
        { operation: "create", method: "POST", path: base, summary: `Create a ${entity.name}` },
        {
          operation: "update",
          method: "PATCH",
          path: `${base}/:id`,
          summary: `Update a ${entity.name}`,
        },
        {
          operation: "delete",
          method: "DELETE",
          path: `${base}/:id`,
          summary: entity.softDelete
            ? `Soft delete a ${entity.name}`
            : `Delete a ${entity.name}`,
        },
      ];

      const organizations = context.featureConfig("organizations") as
        | { roles?: string[] }
        | undefined;
      const orgRoles = organizations?.roles ?? ["owner", "admin", "member"];
      const destructiveRoles =
        entity.tenant !== null && organizations !== undefined
          ? (parsed.destructiveOrgRoles ??
            orgRoles.slice(0, Math.max(1, orgRoles.length - 1)))
          : authenticated && entity.ownership === null
            ? (parsed.destructiveRoles ?? adminRoles)
            : [];

      for (const operation of operations) {
        endpoints.push({
          id: `${entity.name}.${operation.operation}`,
          feature: "crud",
          method: operation.method,
          path: operation.path,
          entity: entity.name,
          operation: operation.operation,
          summary: operation.summary,
          auth: authenticated ? "authenticated" : "public",
          // Destructive operations are role-restricted unless row ownership
          // already limits them to the caller's own records.
          roles: operation.operation === "delete" ? destructiveRoles : [],
        });

        permissions.push({
          feature: "crud",
          entity: entity.name,
          action: operation.operation,
          roles: operation.operation === "delete" ? destructiveRoles : adminRoles,
          requiresOwnership: entity.ownership !== null,
          requiresTenant: entity.tenant !== null,
        });
      }
    }

    return { endpoints, permissions };
  },

  renderers: { [TARGET_ID]: crudRenderer },

  agentSummary:
    "Generates REST resources for the listed entities: POST, GET (one and paginated list with filters and sort), PATCH and DELETE. Options: softDelete (list of entities), ownedBy (entity -> owner entity, requires auth), adminRoles, destructiveRoles, destructiveOrgRoles, defaultPageSize, maxPageSize.",

  examples: [
    { name: "All entities, defaults", config: {} },
    {
      name: "Soft delete and ownership",
      config: { softDelete: ["Note"], ownedBy: { Note: "User" }, adminRoles: ["admin"] },
    },
  ],

  conformance: [
    {
      name: "crud-default",
      description: "Every specification entity gets a full REST resource.",
      config: {},
      expectFiles: [
        "src/generated/note/note.controller.ts",
        "src/generated/note/note.service.ts",
        "src/generated/note/dto/create-note.dto.ts",
        "src/generated/note/note.service.spec.ts",
        "test/note.e2e-spec.ts",
      ],
      expectEndpoints: ["Note.list", "Note.read", "Note.create", "Note.update", "Note.delete"],
    },
  ],
};
