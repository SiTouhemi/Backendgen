import { describe, expect, it } from "vitest";
import { validateSpec } from "./validate.js";

function validSpec(): Record<string, any> {
  return {
    specVersion: "backendcompiler.dev/v1",
    project: { name: "test-api" },
    target: { id: "nestjs-prisma", database: "postgresql" },
    entities: {
      User: {
        fields: {
          email: { type: "string", required: true, unique: true },
        },
      },
      Room: {
        fields: { number: "string" },
        relations: [{ name: "owner", type: "belongsTo", target: "User" }],
      },
    },
    features: { crud: {} },
  };
}

describe("validateSpec", () => {
  it("accepts a valid v1 specification", () => {
    const result = validateSpec(validSpec());

    expect(result.ok).toBe(true);
  });

  it("reports schema errors with stable codes and paths", () => {
    const input = validSpec();
    input.project.name = "Invalid Name";

    const result = validateSpec(input);

    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: "schema.pattern",
          path: "/project/name",
        },
      ],
    });
  });

  it("rejects relations that reference missing entities", () => {
    const input = validSpec();
    input.entities.Room.relations[0]!.target = "MissingUser";

    const result = validateSpec(input);

    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: "semantic.unknown-relation-target",
          path: "/entities/Room/relations/owner/target",
        },
      ],
    });
  });

  it("rejects indexes that reference missing fields", () => {
    const input = validSpec();
    Object.assign(input.entities.Room, { indexes: [{ fields: ["missing"] }] });

    const result = validateSpec(input);

    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: "semantic.unknown-index-field",
          path: "/entities/Room/indexes/0/fields",
        },
      ],
    });
  });

  it("accepts indexes on relation foreign keys, like the compiler does", () => {
    const input = validSpec();
    Object.assign(input.entities.Room, { indexes: [{ fields: ["ownerId"] }] });

    const result = validateSpec(input);

    expect(result.ok).toBe(true);
  });

  it("accepts holdMinutes 0, which disables holds", () => {
    const input = validSpec();
    input.features = {
      reservations: { resource: "Room", owner: "User", holdMinutes: 0 },
    };

    const result = validateSpec(input);

    expect(result.ok).toBe(true);
  });

  it("validates reservation entity references and hold duration", () => {
    const input = validSpec();
    input.features = {
      // holdMinutes 0 is valid (it disables holds); negative values are not.
      reservations: { resource: "MissingRoom", owner: "User", holdMinutes: -5 },
    };

    const result = validateSpec(input);

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "semantic.unknown-feature-entity" }),
        expect.objectContaining({ code: "semantic.invalid-hold-duration" }),
      ]),
    });
  });
});
