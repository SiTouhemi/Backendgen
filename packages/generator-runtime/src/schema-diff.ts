import type {
  SchemaChange,
  SchemaChangeKind,
  SchemaSnapshot,
  SnapshotEnum,
  SnapshotForeignKey,
  SnapshotTable,
} from "@backend-compiler/target-sdk";

/**
 * How risky a change is to apply to a database that already holds data.
 *  - `safe`         applies without data loss or a required backfill.
 *  - `needs-default` adds a NOT NULL column to an existing table; only valid
 *    when the column carries a default to backfill existing rows.
 *  - `destructive`  can lose data or silently change delete semantics.
 */
export type ChangeSafety = "safe" | "needs-default" | "destructive";

export function changeSafety(change: SchemaChange): ChangeSafety {
  switch (change.kind) {
    case "drop-table":
    case "drop-column":
    case "drop-enum":
    case "alter-column-type":
      return "destructive";
    case "add-foreign-key":
      return change.recreated && change.foreignKey.onDelete === "CASCADE" ? "destructive" : "safe";
    case "add-column":
      return change.column.nullable ? "safe" : "needs-default";
    default:
      return "safe";
  }
}

/** A one-line human description of a change, used in issue messages and diff reports. */
export function describeChange(change: SchemaChange): string {
  switch (change.kind) {
    case "create-table":
      return `create table "${change.table}"`;
    case "drop-table":
      return `drop table "${change.table}"`;
    case "add-column":
      return `add column "${change.table}"."${change.column.name}"`;
    case "drop-column":
      return `drop column "${change.table}"."${change.column}"`;
    case "alter-column-type":
      return `change type of "${change.table}"."${change.column}" (${change.from} -> ${change.to})`;
    case "alter-column-nullability":
      return `${change.nullable ? "relax" : "tighten"} nullability of "${change.table}"."${change.column}"`;
    case "alter-column-default":
      return `change default of "${change.table}"."${change.column}"`;
    case "add-index":
      return `add index "${change.index.name}"`;
    case "drop-index":
      return `drop index "${change.index}"`;
    case "add-foreign-key":
      return `add foreign key "${change.foreignKey.name}" on "${change.table}"`;
    case "drop-foreign-key":
      return `drop foreign key "${change.foreignKey}" on "${change.table}"`;
    case "create-enum":
      return `create enum "${change.enum.name}"`;
    case "add-enum-value":
      return `add value '${change.value}' to enum "${change.enum}"`;
    case "drop-enum":
      return `drop enum "${change.enum}"`;
    case "add-feature-sql":
      return "add feature-owned SQL";
    case "drop-feature-sql":
      return "remove feature-owned SQL";
  }
}

function indexByName<T extends { name: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name, item]));
}

function diffEnums(previous: SchemaSnapshot, next: SchemaSnapshot): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const before = indexByName(previous.enums);
  const after = indexByName(next.enums);

  for (const [name, enumValue] of after) {
    if (!before.has(name)) {
      changes.push({ kind: "create-enum", enum: enumValue });
    }
  }

  for (const [name] of before) {
    if (!after.has(name)) {
      changes.push({ kind: "drop-enum", enum: name });
    }
  }

  for (const [name, nextEnum] of after) {
    const prevEnum = before.get(name);
    if (prevEnum === undefined) continue;
    changes.push(...diffEnumValues(name, prevEnum, nextEnum));
  }

  return changes;
}

function diffEnumValues(name: string, previous: SnapshotEnum, next: SnapshotEnum): SchemaChange[] {
  const prevValues = new Set(previous.values);
  const removed = previous.values.filter((value) => !next.values.includes(value));

  // A removed or reordered value cannot be expressed with ALTER TYPE ADD VALUE.
  // Recreating the type is destructive (dependent columns must be rewritten), so
  // model it as drop + create and let the safety gate refuse it.
  if (removed.length > 0) {
    return [
      { kind: "drop-enum", enum: name },
      { kind: "create-enum", enum: next },
    ];
  }

  const changes: SchemaChange[] = [];
  for (let index = 0; index < next.values.length; index += 1) {
    const value = next.values[index] as string;
    if (prevValues.has(value)) continue;
    const preceding = index > 0 ? (next.values[index - 1] as string) : null;
    const after = preceding !== null && prevValues.has(preceding) ? preceding : null;
    changes.push({ kind: "add-enum-value", enum: name, value, after });
  }
  return changes;
}

function diffTableInternals(previous: SnapshotTable, next: SnapshotTable): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const table = next.name;

  const beforeColumns = indexByName(previous.columns);
  const afterColumns = indexByName(next.columns);

  for (const column of next.columns) {
    const before = beforeColumns.get(column.name);
    if (before === undefined) {
      changes.push({ kind: "add-column", table, column });
      continue;
    }
    if (before.sqlType !== column.sqlType) {
      changes.push({
        kind: "alter-column-type",
        table,
        column: column.name,
        from: before.sqlType,
        to: column.sqlType,
      });
    }
    if (before.nullable !== column.nullable) {
      changes.push({ kind: "alter-column-nullability", table, column: column.name, nullable: column.nullable });
    }
    if (before.default !== column.default) {
      changes.push({ kind: "alter-column-default", table, column: column.name, default: column.default });
    }
  }

  for (const column of previous.columns) {
    if (!afterColumns.has(column.name)) {
      changes.push({ kind: "drop-column", table, column: column.name });
    }
  }

  const beforeIndexes = indexByName(previous.indexes);
  const afterIndexes = indexByName(next.indexes);
  const sameIndex = (name: string): boolean => {
    const a = beforeIndexes.get(name);
    const b = afterIndexes.get(name);
    return a !== undefined && b !== undefined && a.unique === b.unique &&
      a.columns.length === b.columns.length && a.columns.every((column, position) => column === b.columns[position]);
  };

  for (const name of beforeIndexes.keys()) {
    if (!afterIndexes.has(name) || !sameIndex(name)) {
      changes.push({ kind: "drop-index", table, index: name });
    }
  }
  for (const [name, index] of afterIndexes) {
    if (!beforeIndexes.has(name) || !sameIndex(name)) {
      changes.push({ kind: "add-index", table, index });
    }
  }

  const beforeKeys = indexByName(previous.foreignKeys);
  const afterKeys = indexByName(next.foreignKeys);
  const sameKey = (a: SnapshotForeignKey, b: SnapshotForeignKey): boolean =>
    a.column === b.column && a.target === b.target && a.onDelete === b.onDelete;

  for (const [name] of beforeKeys) {
    const after = afterKeys.get(name);
    if (after === undefined || !sameKey(beforeKeys.get(name) as SnapshotForeignKey, after)) {
      changes.push({ kind: "drop-foreign-key", table, foreignKey: name });
    }
  }
  for (const [name, key] of afterKeys) {
    const before = beforeKeys.get(name);
    if (before === undefined) {
      changes.push({ kind: "add-foreign-key", table, foreignKey: key, recreated: false });
    } else if (!sameKey(before, key)) {
      changes.push({ kind: "add-foreign-key", table, foreignKey: key, recreated: true });
    }
  }

  return changes;
}

function diffTables(previous: SchemaSnapshot, next: SchemaSnapshot): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const before = indexByName(previous.tables);
  const after = indexByName(next.tables);

  for (const [name, table] of after) {
    if (before.has(name)) continue;
    // A brand-new table: create it, then add its indexes and foreign keys as
    // their own (safe) changes, exactly as the initial migration is sectioned.
    changes.push({ kind: "create-table", table: name, snapshot: table });
    for (const index of table.indexes) {
      changes.push({ kind: "add-index", table: name, index });
    }
    for (const key of table.foreignKeys) {
      changes.push({ kind: "add-foreign-key", table: name, foreignKey: key, recreated: false });
    }
  }

  for (const [name] of before) {
    if (!after.has(name)) {
      changes.push({ kind: "drop-table", table: name });
    }
  }

  for (const [name, nextTable] of after) {
    const prevTable = before.get(name);
    if (prevTable === undefined) continue;
    changes.push(...diffTableInternals(prevTable, nextTable));
  }

  return changes;
}

function diffFeatureSql(previous: SchemaSnapshot, next: SchemaSnapshot): SchemaChange[] {
  const before = new Set(previous.featureSql);
  const after = new Set(next.featureSql);
  const changes: SchemaChange[] = [];

  for (const sql of previous.featureSql) {
    if (!after.has(sql)) changes.push({ kind: "drop-feature-sql", sql });
  }
  for (const sql of next.featureSql) {
    if (!before.has(sql)) changes.push({ kind: "add-feature-sql", sql });
  }
  return changes;
}

/** Deterministic emission order: drops first, then structural adds, then data-carrying adds. */
const KIND_ORDER: Record<SchemaChangeKind, number> = {
  "drop-feature-sql": 0,
  "drop-foreign-key": 1,
  "drop-index": 2,
  "drop-column": 3,
  "drop-table": 4,
  "drop-enum": 5,
  "create-enum": 6,
  "create-table": 7,
  "alter-column-type": 8,
  "alter-column-nullability": 9,
  "alter-column-default": 10,
  "add-column": 11,
  "add-index": 12,
  "add-foreign-key": 13,
  "add-feature-sql": 14,
  "add-enum-value": 15,
};

function secondaryKey(change: SchemaChange): string {
  switch (change.kind) {
    case "create-table":
    case "drop-table":
      return change.table;
    case "add-column":
      return `${change.table} ${change.column.name}`;
    case "drop-column":
    case "alter-column-type":
    case "alter-column-nullability":
    case "alter-column-default":
      return `${change.table} ${change.column}`;
    case "add-index":
      return `${change.table} ${change.index.name}`;
    case "drop-index":
      return `${change.table} ${change.index}`;
    case "add-foreign-key":
      return `${change.table} ${change.foreignKey.name}`;
    case "drop-foreign-key":
      return `${change.table} ${change.foreignKey}`;
    case "create-enum":
      return change.enum.name;
    case "drop-enum":
      return change.enum;
    case "add-enum-value":
      return `${change.enum} ${change.value}`;
    case "add-feature-sql":
    case "drop-feature-sql":
      return change.sql;
  }
}

/**
 * Orders foreign-key additions so a referenced (parent) table's own foreign keys
 * are added before those of a table that references it. All target tables
 * already exist by this section, so this is about determinism and readability
 * rather than correctness, but it honours the parents-before-children rule.
 */
function orderForeignKeyAdds(changes: SchemaChange[]): SchemaChange[] {
  const fkAdds = changes.filter(
    (change): change is Extract<SchemaChange, { kind: "add-foreign-key" }> =>
      change.kind === "add-foreign-key",
  );
  if (fkAdds.length === 0) return changes;

  const tables = [...new Set(fkAdds.map((change) => change.table))].sort();
  const references = new Map<string, Set<string>>(
    tables.map((table) => [table, new Set<string>()]),
  );
  for (const change of fkAdds) {
    const target = change.foreignKey.target;
    if (references.has(change.table) && references.has(target) && target !== change.table) {
      references.get(change.table)!.add(target);
    }
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  // Kahn-style: a table is emitted once every table it references is emitted.
  // Ties break alphabetically for determinism; cycles fall back to that order.
  while (ordered.length < tables.length) {
    const ready = tables.filter(
      (table) =>
        !placed.has(table) &&
        [...references.get(table)!].every((target) => placed.has(target) || !references.has(target)),
    );
    const batch = ready.length > 0 ? ready : tables.filter((table) => !placed.has(table));
    for (const table of batch) {
      ordered.push(table);
      placed.add(table);
    }
  }

  const rank = new Map(ordered.map((table, index) => [table, index] as const));
  return [...changes].sort((left, right) => {
    if (left.kind !== "add-foreign-key" || right.kind !== "add-foreign-key") return 0;
    const byTable = (rank.get(left.table) ?? 0) - (rank.get(right.table) ?? 0);
    if (byTable !== 0) return byTable;
    return left.foreignKey.name < right.foreignKey.name ? -1 : 1;
  });
}

/**
 * Diffs two schema snapshots into an ordered, deterministic list of changes.
 * Ordering: every drop before every add, parents before children for foreign
 * keys, and `ALTER TYPE ADD VALUE` last (the SQL emitter also isolates those in
 * their own section).
 */
export function diffSchemas(previous: SchemaSnapshot, next: SchemaSnapshot): SchemaChange[] {
  const changes = [
    ...diffEnums(previous, next),
    ...diffTables(previous, next),
    ...diffFeatureSql(previous, next),
  ];

  changes.sort((left, right) => {
    const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (byKind !== 0) return byKind;
    const leftKey = secondaryKey(left);
    const rightKey = secondaryKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  return orderForeignKeyAdds(changes);
}
