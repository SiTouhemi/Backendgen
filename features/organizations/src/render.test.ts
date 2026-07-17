import type { NormalizedEntity } from "@backend-compiler/compiler";
import type { TargetRenderContext } from "@backend-compiler/target-sdk";
import { describe, expect, it } from "vitest";
import { organizationsRenderer } from "./render.js";

function render(options?: { userSoftDelete?: boolean }) {
  const entities = new Map<string, NormalizedEntity>([
    [
      "User",
      {
        name: "User",
        softDelete: options?.userSoftDelete ?? false,
        tenant: null,
        ownership: null,
      } as unknown as NormalizedEntity,
    ],
  ]);

  const context = {
    config: { roles: ["owner", "admin", "member"], userEntity: "User" },
    ir: { project: { name: "orgs-test-api" }, entities: [] },
    settings: { apiPrefix: "api" },
    hasFeature: (name: string) => name === "auth" || name === "crud",
    featureConfig: () => undefined,
    entity: (name: string) => entities.get(name),
    crudEntities: () => [],
  } as unknown as TargetRenderContext;

  return organizationsRenderer.render(context);
}

function contents(result: ReturnType<typeof render>, path: string): string {
  const rendered = result.files.find((candidate) => candidate.path === path);
  if (rendered === undefined) throw new Error(`Missing rendered file ${path}`);
  return rendered.contents;
}

const SERVICE = "src/generated/organizations/organization.service.ts";
const SPEC = "src/generated/organizations/organization.service.spec.ts";

describe("organizations renderer", () => {
  it("ignores soft-deleted accounts in membership and owner-count queries", () => {
    const service = contents(render({ userSoftDelete: true }), SERVICE);

    // Owner counts must only see active owners.
    expect(service).toContain(
      "where: { organizationId, role: OWNER_ROLE as never, user: { deletedAt: null } }",
    );
    // Demoting or removing a soft-deleted owner is not guarded by the count;
    // the invariant protects the last *active* owner.
    expect(service).toContain(
      "if (membership.user.deletedAt === null && membership.role === OWNER_ROLE",
    );
    // Adding a member requires an active account.
    expect(service).toContain("where: { email: dto.email.trim().toLowerCase(), deletedAt: null }");
    // Membership checks and member listings only see active accounts.
    expect(service).toContain("where: { organizationId, userId, user: { deletedAt: null } }");
    expect(service).toContain("where: { organizationId, user: { deletedAt: null } }");
  });

  it("emits no soft-delete filters when the user entity is hard-deleted", () => {
    const service = contents(render({ userSoftDelete: false }), SERVICE);

    expect(service).not.toContain("deletedAt");
    expect(service).toContain("where: { organizationId, role: OWNER_ROLE as never }");
  });

  it("generates active-owner regression tests into the project", () => {
    const spec = contents(render({ userSoftDelete: true }), SPEC);

    expect(spec).toContain("refuses to demote the last active owner");
    expect(spec).toContain("refuses to remove the last active owner");
    expect(spec).toContain("allows demoting a soft-deleted owner without counting it as active");
    expect(spec).toContain("refuses to add a soft-deleted account as a member");
  });
});
