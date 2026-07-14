import { CompilerError } from "@backend-compiler/common";
import type { BackendSpec } from "@backend-compiler/specification";
import { describe, expect, it } from "vitest";
import {
  applyEntityContributions,
  compileSpec,
  normalizeEntities,
  specToDrafts,
} from "./compile.js";
import { IR_VERSION } from "./ir.js";

const spec: BackendSpec = {
  specVersion: "backendcompiler.dev/v1",
  project: { name: "rooms-api" },
  target: { id: "nestjs-prisma", database: "postgresql" },
  entities: {
    Hotel: {
      fields: { name: { type: "string", required: true } },
    },
    Room: {
      fields: {
        price: { type: "decimal", required: true, minimum: 0 },
        number: "string",
      },
      relations: [{ name: "hotel", type: "belongsTo", target: "Hotel", required: true }],
    },
  },
  features: {},
};

describe("compileSpec", () => {
  it("normalizes optional values and produces stable ordering", () => {
    const ir = compileSpec(spec);

    expect(IR_VERSION).toBe("backendcompiler.ir/v2");
    expect(ir.irVersion).toBe(IR_VERSION);
    expect(ir.entities.map((entity) => entity.name)).toEqual(["Hotel", "Room"]);
    expect(ir.entities[1]).toMatchObject({
      name: "Room",
      description: null,
      origin: "spec",
      crud: false,
      fields: [
        { name: "number", required: false, unique: false },
        {
          name: "price",
          required: true,
          constraints: { minimum: 0, maximum: null },
        },
      ],
    });
  });

  it("emits no feature semantics before feature packs run", () => {
    const ir = compileSpec(spec);

    expect(ir.endpoints).toEqual([]);
    expect(ir.secrets).toEqual([]);
    expect(ir.features).toEqual([]);
  });

  it("records the target database as core infrastructure", () => {
    const ir = compileSpec(spec);

    expect(ir.infrastructure).toEqual([
      {
        kind: "database",
        name: "postgresql",
        feature: "core",
        reason: "Selected target database",
        portabilityNote: null,
      },
    ]);
  });
});

describe("relation derivation", () => {
  it("derives the inverse side of a declared belongsTo relation", () => {
    const ir = compileSpec(spec);
    const hotel = ir.entities.find((entity) => entity.name === "Hotel")!;
    const room = ir.entities.find((entity) => entity.name === "Room")!;

    expect(room.relations).toEqual([
      {
        name: "hotel",
        type: "belongsTo",
        target: "Hotel",
        required: true,
        origin: "declared",
        inverseName: "rooms",
        relationName: "RoomHotel",
        owner: true,
        foreignKey: "hotelId",
        unique: false,
        onDelete: "restrict",
      },
    ]);
    expect(hotel.relations).toEqual([
      {
        name: "rooms",
        type: "hasMany",
        target: "Room",
        required: false,
        origin: "derived",
        inverseName: "hotel",
        relationName: "RoomHotel",
        owner: false,
        foreignKey: null,
        unique: false,
        onDelete: "restrict",
      },
    ]);
  });

  it("normalizes safe defaults and explicit referential actions", () => {
    const actionSpec: BackendSpec = {
      ...spec,
      entities: {
        Parent: { fields: { name: "string" } },
        CascadeChild: {
          fields: { name: "string" },
          relations: [
            {
              name: "parent",
              type: "belongsTo",
              target: "Parent",
              required: true,
              onDelete: "cascade",
            },
          ],
        },
        OptionalChild: {
          fields: { name: "string" },
          relations: [{ name: "parent", type: "belongsTo", target: "Parent" }],
        },
        RestrictedChild: {
          fields: { name: "string" },
          relations: [
            {
              name: "parent",
              type: "belongsTo",
              target: "Parent",
              onDelete: "restrict",
            },
          ],
        },
        RequiredChild: {
          fields: { name: "string" },
          relations: [
            { name: "parent", type: "belongsTo", target: "Parent", required: true },
          ],
        },
        SetNullChild: {
          fields: { name: "string" },
          relations: [
            { name: "parent", type: "belongsTo", target: "Parent", onDelete: "setNull" },
          ],
        },
      },
    };

    const ir = compileSpec(actionSpec);
    const actions = Object.fromEntries(
      ir.entities
        .filter((entity) => entity.name !== "Parent")
        .map((entity) => [entity.name, entity.relations.find((relation) => relation.owner)!.onDelete]),
    );

    expect(actions).toEqual({
      CascadeChild: "cascade",
      OptionalChild: "setNull",
      RequiredChild: "restrict",
      RestrictedChild: "restrict",
      SetNullChild: "setNull",
    });
  });

  it("rejects setNull on a required owning relation with a stable issue", () => {
    try {
      normalizeEntities([
        { name: "Parent", origin: "spec", fields: [{ name: "name", type: "string" }] },
        {
          name: "Child",
          origin: "spec",
          fields: [{ name: "name", type: "string" }],
          relations: [
            {
              name: "parent",
              type: "belongsTo",
              target: "Parent",
              required: true,
              onDelete: "setNull",
            },
          ],
        },
      ]);
      throw new Error("Expected relation normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CompilerError);
      expect((error as CompilerError).issues[0]).toMatchObject({
        code: "semantic.set-null-requires-optional-relation",
        path: "/entities/Child/relations/parent/onDelete",
      });
    }
  });

  it("applies hasMany onDelete to the derived owning foreign key", () => {
    const entities = normalizeEntities([
      {
        name: "Parent",
        origin: "spec",
        fields: [{ name: "name", type: "string" }],
        relations: [
          {
            name: "children",
            type: "hasMany",
            target: "Child",
            onDelete: "cascade",
          },
        ],
      },
      { name: "Child", origin: "spec", fields: [{ name: "name", type: "string" }] },
    ]);
    const childRelation = entities
      .find((entity) => entity.name === "Child")!
      .relations.find((relation) => relation.owner)!;

    expect(childRelation).toMatchObject({
      type: "belongsTo",
      foreignKey: "parentId",
      required: false,
      onDelete: "cascade",
    });
  });

  it("rejects meaningless collection required and many-to-many onDelete options", () => {
    const base = [
      { name: "Parent", origin: "spec" as const, fields: [{ name: "name", type: "string" as const }] },
      { name: "Child", origin: "spec" as const, fields: [{ name: "name", type: "string" as const }] },
    ];

    for (const relation of [
      {
        name: "children",
        type: "hasMany" as const,
        target: "Child",
        required: false,
        expectedCode: "semantic.collection-relation-required-unsupported",
      },
      {
        name: "children",
        type: "manyToMany" as const,
        target: "Child",
        onDelete: "cascade" as const,
        expectedCode: "semantic.many-to-many-on-delete-unsupported",
      },
    ]) {
      const { expectedCode, ...draftRelation } = relation;
      try {
        normalizeEntities([
          { ...base[0]!, relations: [draftRelation] },
          base[1]!,
        ]);
        throw new Error("Expected relation normalization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CompilerError);
        expect((error as CompilerError).issues[0]?.code).toBe(expectedCode);
      }
    }
  });

  it("rejects relations pointing at unknown entities", () => {
    expect(() =>
      normalizeEntities([
        {
          name: "Room",
          origin: "spec",
          fields: [{ name: "number", type: "string" }],
          relations: [{ name: "hotel", type: "belongsTo", target: "Missing" }],
        },
      ]),
    ).toThrowError(/Unknown relation target/);
  });

  it("rejects target-reserved scalar names and derived foreign-key collisions", () => {
    expect(() =>
      normalizeEntities([
        {
          name: "User",
          origin: "spec",
          fields: [{ name: "id", type: "string" }],
        },
      ]),
    ).toThrowError(/is reserved/);

    expect(() =>
      normalizeEntities([
        { name: "User", origin: "spec", fields: [] },
        {
          name: "Note",
          origin: "spec",
          fields: [{ name: "ownerId", type: "string" }],
          relations: [{ name: "owner", type: "belongsTo", target: "User" }],
        },
      ]),
    ).toThrowError(/Foreign key 'Note.ownerId' collides/);

    expect(() =>
      normalizeEntities([
        {
          name: "Archived",
          origin: "spec",
          softDelete: true,
          fields: [{ name: "deletedAt", type: "datetime" }],
        },
      ]),
    ).toThrowError(/is reserved/);
  });
});

describe("applyEntityContributions", () => {
  it("lets a feature create entities and extend existing ones in order", () => {
    const result = applyEntityContributions(
      specToDrafts(spec),
      [
        {
          name: "Session",
          origin: "feature",
          ownerFeature: "auth",
          fields: [{ name: "tokenHash", type: "string", required: true, internal: true }],
        },
      ],
      [
        { entity: "Room", crud: true },
        { entity: "Room", addFields: [{ name: "archived", type: "boolean" }], crud: false },
      ],
    );

    const room = result.find((entity) => entity.name === "Room")!;
    expect(room.crud).toBe(false);
    expect(room.fields.map((field) => field.name)).toContain("archived");
    expect(result.map((entity) => entity.name)).toEqual(["Hotel", "Room", "Session"]);
  });

  it("fails when a feature creates an entity that already exists", () => {
    expect(() =>
      applyEntityContributions(
        specToDrafts(spec),
        [{ name: "Room", origin: "feature", ownerFeature: "auth", fields: [] }],
        [],
      ),
    ).toThrowError(/already exists/);
  });

  it("fails when a feature patches an unknown entity", () => {
    expect(() =>
      applyEntityContributions(specToDrafts(spec), [], [{ entity: "Ghost", crud: true }]),
    ).toThrowError(/does not exist/);
  });

  it("fails closed when a feature-owned field or relation name already exists", () => {
    expect(() =>
      applyEntityContributions(specToDrafts(spec), [], [
        {
          entity: "Room",
          addFields: [{ name: "number", type: "string", internal: true }],
        },
      ]),
    ).toThrowError(/reserved by a feature/);

    expect(() =>
      applyEntityContributions(specToDrafts(spec), [], [
        {
          entity: "Room",
          addRelations: [{ name: "hotel", type: "belongsTo", target: "Hotel" }],
        },
      ]),
    ).toThrowError(/reserved by a feature/);
  });
});
