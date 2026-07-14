import { describe, expect, it } from "vitest";
import { FeatureRegistry } from "./registry.js";
import { resolveFeatures } from "./resolve.js";
import type { FeaturePack } from "./types.js";

function pack(overrides: Partial<FeaturePack> & { name: string }): FeaturePack {
  return {
    version: "1.0.0",
    description: overrides.name,
    configSchema: { type: "object", additionalProperties: false, properties: {} },
    dependsOn: [],
    conflictsWith: [],
    supportedTargets: ["nestjs-prisma"],
    requiredEntities: () => [],
    contributeEntities: () => ({}),
    contribute: () => ({}),
    renderers: {},
    agentSummary: overrides.name,
    examples: [],
    conformance: [],
    ...overrides,
  };
}

const target = { id: "nestjs-prisma", database: "postgresql" } as const;

function resolve(
  packs: FeaturePack[],
  requested: Record<string, Record<string, unknown>>,
  specEntities: string[] = ["User"],
) {
  return resolveFeatures({
    registry: new FeatureRegistry(packs),
    requested,
    target,
    specEntities,
  });
}

describe("resolveFeatures", () => {
  it("orders features by dependency, then alphabetically", () => {
    const result = resolve(
      [
        pack({ name: "auth", dependsOn: ["crud"] }),
        pack({ name: "crud" }),
        pack({ name: "reservations", dependsOn: ["auth", "crud"] }),
        pack({ name: "notifications" }),
      ],
      { reservations: {}, notifications: {}, auth: {}, crud: {} },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.features.map((feature) => feature.pack.name)).toEqual([
      "crud",
      "auth",
      "notifications",
      "reservations",
    ]);
  });

  it("produces the same order regardless of how the specification lists features", () => {
    const packs = [
      pack({ name: "auth", dependsOn: ["crud"] }),
      pack({ name: "crud" }),
      pack({ name: "reservations", dependsOn: ["auth"] }),
    ];

    const forward = resolve(packs, { crud: {}, auth: {}, reservations: {} });
    const reverse = resolve(packs, { reservations: {}, auth: {}, crud: {} });

    expect(forward.ok && reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) return;

    expect(forward.features.map((feature) => feature.pack.name)).toEqual(
      reverse.features.map((feature) => feature.pack.name),
    );
  });

  it("reports an unknown feature", () => {
    const result = resolve([pack({ name: "crud" })], { ghost: {} });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "feature.unknown", path: "/features/ghost" }],
    });
  });

  it("reports a missing dependency instead of silently adding it", () => {
    const result = resolve(
      [pack({ name: "auth", dependsOn: ["crud"] }), pack({ name: "crud" })],
      { auth: {} },
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "feature.missing-dependency", path: "/features/auth" }],
    });
  });

  it("detects a circular dependency", () => {
    const result = resolve(
      [pack({ name: "a", dependsOn: ["b"] }), pack({ name: "b", dependsOn: ["a"] })],
      { a: {}, b: {} },
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "feature.circular-dependency", path: "/features" }],
    });
  });

  it("detects incompatible features", () => {
    const result = resolve(
      [pack({ name: "sessions", conflictsWith: ["jwt"] }), pack({ name: "jwt" })],
      { sessions: {}, jwt: {} },
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "feature.conflict", path: "/features/sessions" }],
    });
  });

  it("rejects a feature that does not support the target", () => {
    const result = resolve([pack({ name: "crud", supportedTargets: ["fastapi"] })], { crud: {} });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "feature.unsupported-target", path: "/features/crud" }],
    });
  });

  it("validates configuration against the feature's schema and applies defaults", () => {
    const packs = [
      pack({
        name: "crud",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pageSize: { type: "integer", minimum: 1, default: 20 },
          },
        },
      }),
    ];

    const invalid = resolve(packs, { crud: { pageSize: 0 } });
    expect(invalid).toMatchObject({
      ok: false,
      issues: [{ code: "feature-config.minimum", path: "/features/crud/pageSize" }],
    });

    const unknownKey = resolve(packs, { crud: { nope: true } });
    expect(unknownKey).toMatchObject({
      ok: false,
      issues: [{ code: "feature-config.additionalProperties" }],
    });

    const valid = resolve(packs, { crud: {} });
    expect(valid.ok && valid.features[0]?.config).toEqual({ pageSize: 20 });
  });

  it("reports an entity a feature requires but the specification does not declare", () => {
    const result = resolve(
      [pack({ name: "auth", requiredEntities: () => ["Account"] })],
      { auth: {} },
      ["User"],
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "feature.missing-entity", path: "/features/auth" }],
    });
  });

  it("surfaces a feature's own cross-field validation", () => {
    const result = resolve(
      [
        pack({
          name: "crud",
          validate: () => [
            { code: "feature.crud.custom", path: "/features/crud", message: "not allowed" },
          ],
        }),
      ],
      { crud: {} },
    );

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "feature.crud.custom" }],
    });
  });
});
