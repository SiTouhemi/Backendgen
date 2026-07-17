import type { NormalizedEntity } from "@backend-compiler/compiler";
import type { TargetRenderContext } from "@backend-compiler/target-sdk";
import { describe, expect, it } from "vitest";
import { uploadsRenderer } from "./render.js";

function render(options?: {
  tenant?: boolean;
  owned?: boolean;
  ttlMinutes?: number;
  parentName?: string;
  multiple?: boolean;
  softDelete?: boolean;
}) {
  const parentNames = options?.multiple
    ? ["Note", "Task"]
    : [options?.parentName ?? "Note"];
  const parents = new Map(
    parentNames.map((name) => [
      name,
      {
        name,
        softDelete: options?.softDelete ?? false,
        tenant: options?.tenant ? { foreignKey: "organizationId" } : null,
        ownership: options?.owned ? { foreignKey: "ownerId" } : null,
      } as unknown as NormalizedEntity,
    ]),
  );

  const context = {
    config: {
      entities: Object.fromEntries(
        parentNames.map((name) => [name, { maxSizeMb: 2, allowedTypes: ["image/png"] }]),
      ),
      presignTtlMinutes: options?.ttlMinutes ?? 7,
      staleAfterMinutes: 60,
    },
    ir: { project: { name: "uploads-test-api" } },
    settings: { apiPrefix: "api" },
    hasFeature: (name: string) =>
      name === "auth" || name === "crud" || (options?.tenant === true && name === "organizations"),
    featureConfig: (name: string) => {
      if (name === "auth") return { roles: ["manager", "member"], defaultRole: "member" };
      if (name === "crud") {
        return {
          adminRoles: ["manager"],
          destructiveRoles: ["manager"],
          destructiveOrgRoles: ["owner"],
        };
      }
      if (name === "organizations" && options?.tenant === true) {
        return { roles: ["owner", "member"] };
      }
      return undefined;
    },
    entity: (name: string) => parents.get(name),
    crudEntities: () => [...parents.values()],
  } as unknown as TargetRenderContext;

  return uploadsRenderer.render(context);
}

function contents(result: ReturnType<typeof render>, path: string): string {
  const rendered = result.files.find((candidate) => candidate.path === path);
  if (rendered === undefined) throw new Error(`Missing rendered file ${path}`);
  return rendered.contents;
}

describe("uploads renderer", () => {
  it("uses the declared TTL and bounds live storage requests", () => {
    const result = render({ ttlMinutes: 7 });
    const s3 = contents(result, "src/generated/uploads/s3.provider.ts");
    const mock = contents(result, "src/generated/uploads/mock.provider.ts");

    expect(s3).toContain("const PRESIGN_TTL_SECONDS = 420;");
    expect(s3).toContain("AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS)");
    expect(s3).toContain("S3_ENDPOINT must be an origin URL");
    expect(s3).toContain("S3_ALLOW_INSECURE_HTTP");
    expect(s3).toContain("'if-none-match': '*'");
    expect(mock).toContain("Date.now() + 420000");
  });

  it("claims stale uploads before deleting objects and completes conditionally", () => {
    const service = contents(
      render({ owned: true }),
      "src/generated/uploads/note-attachment.service.ts",
    );
    const sweeper = service.slice(service.indexOf("async sweepStale"));

    expect(sweeper).toContain('data: { status: \'DELETING\' }');
    expect(sweeper.indexOf("data: { status: 'DELETING' }")).toBeLessThan(
      sweeper.indexOf("await this.storage.delete(record.storageKey)"),
    );
    expect(service).toContain("where: { id: record.id, status: 'UPLOADING' }");
    expect(service).toContain("updated.count !== 1");
    expect(service).toContain('const ADMIN_ROLES: readonly string[] = ["manager"]');
    expect(service).toContain("Keep DELETING rows for a later retry");
    expect(service).not.toContain("as never");
  });

  it("applies the same destructive-role policy as CRUD", () => {
    const globalController = contents(
      render(),
      "src/generated/uploads/note-attachment.controller.ts",
    );
    const tenantController = contents(
      render({ tenant: true }),
      "src/generated/uploads/note-attachment.controller.ts",
    );
    const ownedController = contents(
      render({ owned: true }),
      "src/generated/uploads/note-attachment.controller.ts",
    );

    expect(globalController).toContain('@Roles("manager")');
    expect(tenantController).toContain('@OrgRoles("owner")');
    expect(ownedController).not.toContain("@Roles(");
    expect(ownedController).not.toContain("@OrgRoles(");
  });

  it("defines the stale interval once instead of duplicating service imports", () => {
    const module = contents(render({ multiple: true }), "src/generated/uploads/uploads.module.ts");

    expect(module.match(/const UPLOADS_STALE_AFTER_MS/g)).toHaveLength(1);
    expect(module).not.toContain("Service, UPLOADS_STALE_AFTER_MS");
    expect(module).toContain("NoteAttachmentService");
    expect(module).toContain("TaskAttachmentService");
  });

  it("treats the auth user entity as self-owned without overwriting the requested id", () => {
    const service = contents(
      render({ parentName: "User" }),
      "src/generated/uploads/user-attachment.service.ts",
    );

    expect(service).toContain("id: parentId");
    expect(service).toContain("AND: [{ id: requireUser(scope) }]");
    expect(service).not.toContain("{ id: requireUser(scope) }),");
  });

  it("allows storage-aware attachment deletion after a parent is soft deleted", () => {
    const service = contents(
      render({ softDelete: true }),
      "src/generated/uploads/note-attachment.service.ts",
    );

    expect(service).toContain("this.scopedAttachmentWhere(id, scope, false)");
    expect(service).toContain("requireActiveParent ? { deletedAt: null } : {}");
    expect(service).toContain("Keep a tombstone until the upload URL has expired");
  });
});
