import type { SchemaSnapshot, SnapshotTable } from "@backend-compiler/target-sdk";
import { describe, expect, it } from "vitest";
import { changeSafety, diffSchemas } from "./schema-diff.js";

function table(name: string, overrides: Partial<SnapshotTable> = {}): SnapshotTable {
  return {
    name,
    columns: [{ name: "id", sqlType: "TEXT", nullable: false, default: null }],
    indexes: [],
    foreignKeys: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return { version: 1, enums: [], tables: [], featureSql: [], ...overrides };
}

describe("schema differ", () => {
  it("produces no changes for identical snapshots", () => {
    const state = snapshot({
      tables: [table("Note")],
      enums: [{ name: "NoteStatus", values: ["OPEN"] }],
      featureSql: ["CREATE EXTENSION IF NOT EXISTS btree_gist;"],
    });

    expect(diffSchemas(state, structuredClone(state))).toEqual([]);
  });

  it("detects every column-level change kind with its safety class", () => {
    const before = snapshot({
      tables: [
        table("Note", {
          columns: [
            { name: "id", sqlType: "TEXT", nullable: false, default: null },
            { name: "kept", sqlType: "TEXT", nullable: true, default: null },
            { name: "dropped", sqlType: "TEXT", nullable: true, default: null },
            { name: "retyped", sqlType: "TEXT", nullable: true, default: null },
            { name: "relaxed", sqlType: "TEXT", nullable: false, default: "'x'" },
          ],
        }),
      ],
    });
    const after = snapshot({
      tables: [
        table("Note", {
          columns: [
            { name: "id", sqlType: "TEXT", nullable: false, default: null },
            { name: "kept", sqlType: "TEXT", nullable: true, default: null },
            { name: "retyped", sqlType: "INTEGER", nullable: true, default: null },
            { name: "relaxed", sqlType: "TEXT", nullable: true, default: "'y'" },
            { name: "addedOptional", sqlType: "TEXT", nullable: true, default: null },
            { name: "addedRequired", sqlType: "INTEGER", nullable: false, default: null },
          ],
        }),
      ],
    });

    const changes = diffSchemas(before, after);
    const kinds = changes.map((change) => change.kind);

    expect(kinds).toContain("drop-column");
    expect(kinds).toContain("alter-column-type");
    expect(kinds).toContain("alter-column-nullability");
    expect(kinds).toContain("alter-column-default");
    expect(kinds.filter((kind) => kind === "add-column")).toHaveLength(2);

    const byKind = new Map(changes.map((change) => [change.kind, change] as const));
    expect(changeSafety(byKind.get("drop-column")!)).toBe("destructive");
    expect(changeSafety(byKind.get("alter-column-type")!)).toBe("destructive");
    const adds = changes.filter((change) => change.kind === "add-column");
    expect(adds.map(changeSafety).sort()).toEqual(["needs-default", "safe"]);
  });

  it("orders drops before adds and emits enum value additions last", () => {
    const before = snapshot({
      tables: [table("Old"), table("Note")],
      enums: [{ name: "NoteStatus", values: ["OPEN"] }],
    });
    const after = snapshot({
      tables: [
        table("Note", {
          indexes: [{ name: "Note_x_idx", columns: ["x"], unique: false }],
          columns: [
            { name: "id", sqlType: "TEXT", nullable: false, default: null },
            { name: "x", sqlType: "TEXT", nullable: true, default: null },
          ],
        }),
        table("Fresh"),
      ],
      enums: [{ name: "NoteStatus", values: ["OPEN", "DONE"] }],
    });

    const kinds = diffSchemas(before, after).map((change) => change.kind);

    expect(kinds.indexOf("drop-table")).toBeLessThan(kinds.indexOf("create-table"));
    expect(kinds.indexOf("add-column")).toBeLessThan(kinds.indexOf("add-index"));
    expect(kinds[kinds.length - 1]).toBe("add-enum-value");
  });

  it("orders foreign-key additions parents before children", () => {
    const before = snapshot();
    const child = table("Child", {
      foreignKeys: [
        { name: "Child_parentId_fkey", column: "parentId", target: "Parent", onDelete: "RESTRICT" },
      ],
    });
    const parent = table("Parent", {
      foreignKeys: [
        { name: "Parent_rootId_fkey", column: "rootId", target: "Root", onDelete: "RESTRICT" },
      ],
    });
    const after = snapshot({ tables: [child, parent, table("Root")] });

    const fkTables = diffSchemas(before, after)
      .filter((change) => change.kind === "add-foreign-key")
      .map((change) => (change.kind === "add-foreign-key" ? change.table : ""));

    expect(fkTables.indexOf("Parent")).toBeLessThan(fkTables.indexOf("Child"));
  });

  it("treats enum value removal as a destructive drop and recreate", () => {
    const before = snapshot({ enums: [{ name: "S", values: ["A", "B"] }] });
    const after = snapshot({ enums: [{ name: "S", values: ["A"] }] });

    const changes = diffSchemas(before, after);
    expect(changes.map((change) => change.kind)).toEqual(["drop-enum", "create-enum"]);
    expect(changeSafety(changes[0]!)).toBe("destructive");
  });

  it("recreates a foreign key whose referential action changed, flagging cascade as destructive", () => {
    const before = snapshot({
      tables: [
        table("Child", {
          foreignKeys: [
            { name: "Child_pId_fkey", column: "pId", target: "Parent", onDelete: "RESTRICT" },
          ],
        }),
        table("Parent"),
      ],
    });
    const after = structuredClone(before);
    after.tables[0]!.foreignKeys[0]!.onDelete = "CASCADE";

    const changes = diffSchemas(before, after);
    expect(changes.map((change) => change.kind)).toEqual(["drop-foreign-key", "add-foreign-key"]);
    expect(changeSafety(changes[1]!)).toBe("destructive");
  });

  it("reports feature SQL additions and removals", () => {
    const before = snapshot({ featureSql: ["OLD SQL;"] });
    const after = snapshot({ featureSql: ["NEW SQL;"] });

    const kinds = diffSchemas(before, after).map((change) => change.kind);
    expect(kinds).toEqual(["drop-feature-sql", "add-feature-sql"]);
  });
});
