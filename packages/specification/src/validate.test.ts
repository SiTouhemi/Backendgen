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

  it("accepts every supported referential action on compatible relations", () => {
    const input = validSpec();
    input.entities.Room.relations = [
      {
        name: "requiredOwner",
        type: "belongsTo",
        target: "User",
        required: true,
        onDelete: "restrict",
      },
      {
        name: "cascadingOwner",
        type: "belongsTo",
        target: "User",
        required: true,
        onDelete: "cascade",
      },
      {
        name: "optionalOwner",
        type: "belongsTo",
        target: "User",
        onDelete: "setNull",
      },
      { name: "members", type: "hasMany", target: "User", onDelete: "setNull" },
    ];

    expect(validateSpec(input).ok).toBe(true);
  });

  it("rejects setNull on a required owning relation", () => {
    const input = validSpec();
    input.entities.Room.relations = [
      {
        name: "owner",
        type: "belongsTo",
        target: "User",
        required: true,
        onDelete: "setNull",
      },
    ];

    expect(validateSpec(input)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "semantic.set-null-requires-optional-relation",
          path: "/entities/Room/relations/owner/onDelete",
        }),
      ],
    });
  });

  it("rejects meaningless collection relation options with stable codes", () => {
    const requiredCollection = validSpec();
    requiredCollection.entities.Room.relations = [
      { name: "members", type: "hasMany", target: "User", required: false },
    ];
    expect(validateSpec(requiredCollection)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "semantic.collection-relation-required-unsupported",
          path: "/entities/Room/relations/members/required",
        }),
      ],
    });

    const manyToManyDelete = validSpec();
    manyToManyDelete.entities.Room.relations = [
      {
        name: "members",
        type: "manyToMany",
        target: "User",
        onDelete: "cascade",
      },
    ];
    expect(validateSpec(manyToManyDelete)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "semantic.many-to-many-on-delete-unsupported",
          path: "/entities/Room/relations/members/onDelete",
        }),
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

  it("accepts a hasMany foreign-key index only on the derived owning entity", () => {
    const input = validSpec();
    input.entities.Room.relations = [{ name: "members", type: "hasMany", target: "User" }];
    Object.assign(input.entities.User, { indexes: [{ fields: ["roomId"] }] });

    expect(validateSpec(input).ok).toBe(true);

    Object.assign(input.entities.Room, { indexes: [{ fields: ["membersId"] }] });
    const invalid = validateSpec(input);

    expect(invalid).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "semantic.unknown-index-field" })],
    });
  });

  it("matches compiler inverse-name collision handling for hasMany indexes", () => {
    const input = validSpec();
    input.entities.Room.relations = [{ name: "members", type: "hasMany", target: "User" }];
    input.entities.User.fields.room = "string";
    Object.assign(input.entities.User, { indexes: [{ fields: ["roomViaMembersId"] }] });

    expect(validateSpec(input).ok).toBe(true);
  });

  it("does not invent scalar foreign keys for many-to-many relations", () => {
    const input = validSpec();
    input.entities.Room.relations = [{ name: "members", type: "manyToMany", target: "User" }];
    Object.assign(input.entities.Room, { indexes: [{ fields: ["membersId"] }] });

    const result = validateSpec(input);

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "semantic.unknown-index-field" })],
    });
  });

  it("accepts holdMinutes 0, which disables holds", () => {
    const input = validSpec();
    input.features = {
      reservations: { resource: "Room", owner: "User", holdMinutes: 0 },
    };

    const result = validateSpec(input);

    expect(result.ok).toBe(true);
  });

  it("requires a delivery path for enabled auth recovery flows", () => {
    const input = validSpec();
    input.features = { crud: {}, auth: {} };

    expect(validateSpec(input)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "semantic.auth-recovery-undeliverable",
          path: "/features/auth/emailVerification",
        }),
        expect.objectContaining({
          code: "semantic.auth-recovery-undeliverable",
          path: "/features/auth/passwordReset",
        }),
      ]),
    });

    input.features.auth = { emailVerification: false, passwordReset: false };
    expect(validateSpec(input).ok).toBe(true);

    input.features = { crud: {}, auth: {}, notifications: {} };
    expect(validateSpec(input).ok).toBe(true);
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
