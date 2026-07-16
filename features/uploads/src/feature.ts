import type { DraftEntity } from "@backend-compiler/compiler";
import type {
  FeatureContext,
  FeatureContribution,
  FeatureEntityContext,
  FeatureEntityContribution,
  FeaturePack,
} from "@backend-compiler/feature-sdk";
import { names, TARGET_ID } from "@backend-compiler/target-nestjs-prisma";
import { uploadsRenderer } from "./render.js";

export const UPLOADS_VERSION = "0.2.0";

export const DEFAULT_ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
];

export interface UploadEntityConfig {
  maxSizeMb?: number;
  allowedTypes?: string[];
}

export interface UploadsConfig {
  entities: Record<string, UploadEntityConfig>;
  presignTtlMinutes: number;
  /** UPLOADING rows older than this are swept (with their storage objects). */
  staleAfterMinutes: number;
}

export function uploadsConfig(raw: Record<string, unknown>): UploadsConfig {
  return raw as unknown as UploadsConfig;
}

/** Name of the attachment entity generated for one parent entity. */
export function attachmentEntityName(parent: string): string {
  return `${parent}Attachment`;
}

export const uploadsFeature: FeaturePack = {
  name: "uploads",
  version: UPLOADS_VERSION,
  description:
    "Presigned direct-to-storage file uploads for S3-compatible object stores: size and content-type limits enforced in the signature, server-verified completion, tenant/ownership scoping inherited from the parent entity, and stale-upload cleanup.",
  dependsOn: ["crud"],
  conflictsWith: [],
  supportedTargets: [TARGET_ID],

  configSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["entities"],
    properties: {
      entities: {
        type: "object",
        minProperties: 1,
        propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxSizeMb: { type: "integer", minimum: 1, maximum: 100, default: 10 },
            allowedTypes: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "string", pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$" },
              description: "Allowed MIME types. Defaults to common images plus PDF.",
            },
          },
        },
        description: "Entities that accept file attachments.",
      },
      presignTtlMinutes: { type: "integer", minimum: 1, maximum: 60, default: 15 },
      staleAfterMinutes: { type: "integer", minimum: 5, maximum: 1440, default: 60 },
    },
  },

  requiredEntities(raw): readonly string[] {
    return Object.keys(uploadsConfig(raw).entities ?? {}).sort();
  },

  validate(context: FeatureEntityContext) {
    const config = uploadsConfig(context.config);
    const issues: Array<{ code: string; path: string; message: string }> = [];

    for (const entity of Object.keys(config.entities ?? {})) {
      if (!context.specEntities.includes(entity)) {
        issues.push({
          code: "feature.uploads.unknown-entity",
          path: `/features/uploads/entities/${entity}`,
          message: `Uploads refer to unknown entity '${entity}'.`,
        });
      }
    }

    return issues;
  },

  contributeEntities(context: FeatureEntityContext): FeatureEntityContribution {
    const config = uploadsConfig(context.config);

    const create: DraftEntity[] = Object.keys(config.entities ?? {})
      .sort()
      .map((parent) => ({
        name: attachmentEntityName(parent),
        description: `File attached to a ${parent}, stored in the object store under a server-chosen key.`,
        origin: "feature" as const,
        ownerFeature: "uploads",
        fields: [
          {
            name: "storageKey",
            type: "string",
            required: true,
            unique: true,
            internal: true,
            description: "Server-chosen object key. Clients never influence it.",
          },
          { name: "fileName", type: "string", required: true, maxLength: 200 },
          { name: "contentType", type: "string", required: true, internal: true },
          { name: "sizeBytes", type: "integer", required: true, internal: true },
          {
            name: "status",
            type: "string",
            required: true,
            enumValues: ["UPLOADING", "READY"],
            defaultValue: "UPLOADING",
            internal: true,
          },
        ],
        relations: [
          // Attachments are derived content: they disappear with their parent row.
          { name: "parent", type: "belongsTo", target: parent, required: true, onDelete: "cascade" },
        ],
        indexes: [{ fields: ["status", "createdAt"], unique: false }],
      }));

    return { create };
  },

  contribute(context: FeatureContext): FeatureContribution {
    const config = uploadsConfig(context.config);
    const parents = Object.keys(config.entities ?? {}).sort();
    const auth = context.featureConfig("auth") !== undefined ? ("authenticated" as const) : ("public" as const);

    return {
      endpoints: parents.flatMap((parent) => {
        const attachment = attachmentEntityName(parent);
        const attachmentRoute = names.route(attachment);
        return [
          {
            id: `${attachment}.create`,
            feature: "uploads",
            method: "POST" as const,
            path: `/${names.route(parent)}/:id/attachments`,
            entity: attachment,
            operation: "create",
            summary: `Request a presigned upload for a ${parent}`,
            auth,
            roles: [],
          },
          {
            id: `${attachment}.complete`,
            feature: "uploads",
            method: "POST" as const,
            path: `/${attachmentRoute}/:id/complete`,
            entity: attachment,
            operation: "update",
            summary: "Verify and finalize an upload",
            auth,
            roles: [],
          },
          {
            id: `${attachment}.read`,
            feature: "uploads",
            method: "GET" as const,
            path: `/${attachmentRoute}/:id`,
            entity: attachment,
            operation: "read",
            summary: "Get a presigned download link",
            auth,
            roles: [],
          },
          {
            id: `${attachment}.delete`,
            feature: "uploads",
            method: "DELETE" as const,
            path: `/${attachmentRoute}/:id`,
            entity: attachment,
            operation: "delete",
            summary: "Delete an attachment and its stored object",
            auth,
            roles: [],
          },
        ];
      }),
      // Required only when the s3 provider is selected; the provider itself
      // refuses to construct without them, so tests (mock) can boot without
      // storage credentials while a misconfigured deployment still fails fast.
      secrets: [
        {
          name: "S3_ENDPOINT",
          feature: "uploads",
          description:
            "S3-compatible endpoint URL, e.g. https://s3.amazonaws.com or a MinIO URL. Required when STORAGE_PROVIDER is s3.",
          required: false,
          example: "http://127.0.0.1:9000",
        },
        {
          name: "S3_BUCKET",
          feature: "uploads",
          description: "Bucket every attachment is stored in. Required when STORAGE_PROVIDER is s3.",
          required: false,
          example: "uploads",
        },
        {
          name: "S3_ACCESS_KEY_ID",
          feature: "uploads",
          description:
            "Access key with put/get/delete rights on the bucket. Required when STORAGE_PROVIDER is s3.",
          required: false,
          example: "replace-me",
        },
        {
          name: "S3_SECRET_ACCESS_KEY",
          feature: "uploads",
          description: "Secret for S3_ACCESS_KEY_ID. Required when STORAGE_PROVIDER is s3.",
          required: false,
          example: "replace-me",
        },
        {
          name: "S3_REGION",
          feature: "uploads",
          description: "Signing region. Defaults to us-east-1.",
          required: false,
          example: "us-east-1",
        },
      ],
      infrastructure: [
        {
          kind: "service",
          name: "object-storage",
          feature: "uploads",
          reason: "Stores uploaded files; the API only brokers presigned URLs and metadata.",
          portabilityNote:
            "Any S3-compatible store (AWS S3, MinIO, Cloudflare R2). Local development uses MinIO.",
        },
      ],
      customizationPoints: [],
    };
  },

  renderers: { [TARGET_ID]: uploadsRenderer },

  agentSummary:
    "Direct-to-storage uploads for S3-compatible stores. Config: entities (map of parent entity to { maxSizeMb, allowedTypes }), presignTtlMinutes, staleAfterMinutes. Creates one <Entity>Attachment per parent with tenant/ownership scoping inherited via the parent. Flow: POST /<parents>/:id/attachments with fileName/contentType/sizeBytes returns a presigned PUT (size and type are part of the signature); PUT the bytes; POST /attachments/:id/complete verifies against storage and marks READY; GET /attachments/:id returns a presigned download. Keys are server-chosen. Requires S3_* secrets; the jobs feature (if enabled) sweeps stale uploads.",

  examples: [
    {
      name: "Note images",
      config: { entities: { Note: { maxSizeMb: 5, allowedTypes: ["image/png", "image/jpeg"] } } },
    },
  ],

  conformance: [
    {
      name: "uploads-default",
      description: "Storage abstraction, presigner, controller and integration test exist.",
      config: { entities: { Note: {} } },
      withFeatures: { crud: {} },
      expectFiles: [
        "src/generated/uploads/storage-provider.ts",
        "src/generated/uploads/s3-presign.ts",
        "src/generated/uploads/s3.provider.ts",
        "src/generated/uploads/mock.provider.ts",
        "src/generated/uploads/uploads.module.ts",
      ],
      expectEndpoints: ["NoteAttachment.create", "NoteAttachment.read"],
    },
  ],
};
