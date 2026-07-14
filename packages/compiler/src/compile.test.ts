import type { BackendSpec } from "@backend-compiler/specification";
import { describe, expect, it } from "vitest";
import {
  applyEntityContributions,
  compileSpec,
  normalizeEntities,
  specToDrafts,
} from "./compile.js";

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
      },
    ]);
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
});
