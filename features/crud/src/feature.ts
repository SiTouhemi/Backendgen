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
  adminRoles: string[];
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
        items: { type: "string" },
        default: ["admin"],
        description: "Roles that bypass ownership scoping.",
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
    const authenticated = context.featureConfig("auth") !== undefined;
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
          roles: [],
        });

        permissions.push({
          feature: "crud",
          entity: entity.name,
          action: operation.operation,
          roles: parsed.adminRoles ?? [],
          requiresOwnership: entity.ownership !== null,
          requiresTenant: entity.tenant !== null,
        });
      }
    }

    return { endpoints, permissions };
  },

  renderers: { [TARGET_ID]: crudRenderer },

  agentSummary:
    "Generates REST resources for the listed entities: POST, GET (one and paginated list with filters and sort), PATCH and DELETE. Options: softDelete (list of entities), ownedBy (entity -> owner entity, requires auth), adminRoles, defaultPageSize, maxPageSize.",

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
