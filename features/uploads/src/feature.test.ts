import type { FeatureContext, FeatureEntityContext } from "@backend-compiler/feature-sdk";
import { describe, expect, it } from "vitest";
import { uploadsFeature } from "./feature.js";

const config = {
  entities: { Note: {} },
  presignTtlMinutes: 15,
  staleAfterMinutes: 60,
};

describe("uploads feature", () => {
  it("restricts parent deletion and models cleanup claims explicitly", () => {
    const contribution = uploadsFeature.contributeEntities({
      config,
    } as unknown as FeatureEntityContext);
    const attachment = contribution.create?.[0];

    expect(attachment?.relations?.[0]?.onDelete).toBe("restrict");
    expect(attachment?.fields.find((field) => field.name === "status")?.enumValues).toEqual([
      "UPLOADING",
      "READY",
      "DELETING",
    ]);
  });

  it("publishes destructive account roles on unowned attachment deletion", () => {
    const contribution = uploadsFeature.contribute({
      config,
      entity: () => ({ tenant: null, ownership: null }),
      featureConfig: (name: string) => {
        if (name === "auth") return { roles: ["manager", "member"], defaultRole: "member" };
        if (name === "crud") return { destructiveRoles: ["manager"] };
        return undefined;
      },
    } as unknown as FeatureContext);

    expect(contribution.endpoints?.find((endpoint) => endpoint.operation === "delete")?.roles).toEqual([
      "manager",
    ]);
  });

  it("rejects cleanup before presigned upload URLs expire", () => {
    const issues = uploadsFeature.validate?.({
      config: { ...config, presignTtlMinutes: 30, staleAfterMinutes: 10 },
      specEntities: ["Note"],
    } as unknown as FeatureEntityContext);

    expect(issues).toEqual([
      expect.objectContaining({ code: "feature.uploads.stale-before-presign-expiry" }),
    ]);
  });

  it("treats the auth user entity as self-owned in endpoint metadata", () => {
    const contribution = uploadsFeature.contribute({
      config: { ...config, entities: { User: {} } },
      entity: () => ({ name: "User", tenant: null, ownership: null }),
      featureConfig: (name: string) => {
        if (name === "auth") {
          return { userEntity: "User", roles: ["manager", "member"], defaultRole: "member" };
        }
        if (name === "crud") return { destructiveRoles: ["manager"] };
        return undefined;
      },
    } as unknown as FeatureContext);

    expect(contribution.endpoints?.find((endpoint) => endpoint.operation === "delete")?.roles).toEqual(
      [],
    );
  });
});
