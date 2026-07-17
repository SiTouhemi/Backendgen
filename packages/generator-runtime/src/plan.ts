import { issue, type Issue } from "@backend-compiler/common";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { FileOwnership, RenderedFile } from "@backend-compiler/target-sdk";
import { hashContents, MANIFEST_PATH, type GenerationManifest } from "./manifest.js";

export type FileAction = "create" | "update" | "unchanged" | "delete" | "preserve";

export interface PlannedFile {
  path: string;
  action: FileAction;
  ownership: FileOwnership;
}

export interface FileConflict {
  path: string;
  reason: "modified" | "untracked";
  message: string;
}

export interface GenerationPlan {
  files: PlannedFile[];
  conflicts: FileConflict[];
  warnings: string[];
}

/**
 * Rendered paths are attacker-adjacent input in the MCP case: they come from a
 * specification, which comes from an agent. Nothing may escape the output root.
 */
export function assertSafeRelativePath(path: string): Issue | null {
  if (path.length === 0) {
    return issue("render.invalid-path", "/", "A renderer produced an empty path");
  }

  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    return issue("render.invalid-path", `/${path}`, `Absolute output paths are not allowed: ${path}`);
  }

  const normalized = normalize(path);

  if (normalized.startsWith("..") || normalized.split(/[\\/]/).includes("..")) {
    return issue(
      "render.invalid-path",
      `/${path}`,
      `Output paths may not traverse outside the output directory: ${path}`,
    );
  }

  return null;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Decides what a generation would do, without writing anything.
 *
 * The rules, in order:
 *  - `custom-scaffold` files are written once. If one exists, it is preserved,
 *    whatever it now contains, and whatever `force` says.
 *  - A generated file whose on-disk hash still matches the manifest is safe to
 *    replace.
 *  - A generated file that has been edited since it was written, or that exists
 *    at a generated path without being in the manifest, is a conflict. The
 *    default is to fail rather than to destroy the edit.
 */
export async function planGeneration(input: {
  outputDirectory: string;
  files: readonly RenderedFile[];
  manifest: GenerationManifest | null;
  force: boolean;
}): Promise<GenerationPlan> {
  const { outputDirectory, files, manifest, force } = input;

  const planned: PlannedFile[] = [];
  const conflicts: FileConflict[] = [];
  const warnings: string[] = [];

  const tracked = new Map(
    (manifest?.files ?? []).map((entry) => [entry.path, entry] as const),
  );
  const rendered = new Set(files.map((file) => file.path));

  for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    const absolute = join(outputDirectory, file.path.split("/").join(sep));
    const existing = await readIfPresent(absolute);

    if (file.ownership === "custom-scaffold") {
      planned.push({
        path: file.path,
        action: existing === null ? "create" : "preserve",
        ownership: file.ownership,
      });
      continue;
    }

    if (existing === null) {
      planned.push({ path: file.path, action: "create", ownership: file.ownership });
      continue;
    }

    const entry = tracked.get(file.path);
    const currentHash = hashContents(existing);

    if (entry === undefined) {
      // Byte-identical content is not a conflict: adopt the file into the
      // manifest. This is how an accepted manual migration, whose contents the
      // runtime re-renders verbatim, becomes tracked without --force.
      if (currentHash === hashContents(file.contents)) {
        planned.push({ path: file.path, action: "unchanged", ownership: file.ownership });
        continue;
      }
      if (force) {
        warnings.push(`Overwriting untracked file at a generated path: ${file.path}`);
        planned.push({ path: file.path, action: "update", ownership: file.ownership });
      } else {
        conflicts.push({
          path: file.path,
          reason: "untracked",
          message:
            "A file already exists at a generated path but is not in the manifest. Move it aside, or pass --force to overwrite it.",
        });
      }
      continue;
    }

    if (entry.hash !== currentHash) {
      if (force) {
        warnings.push(`Overwriting locally modified generated file: ${file.path}`);
        planned.push({ path: file.path, action: "update", ownership: file.ownership });
      } else {
        conflicts.push({
          path: file.path,
          reason: "modified",
          message:
            "This generated file was edited after it was generated. Move your change into src/custom/, revert the file, or pass --force to discard the edit.",
        });
      }
      continue;
    }

    const action: FileAction =
      currentHash === hashContents(file.contents) ? "unchanged" : "update";

    // Rewriting a migration in place is safe only while it has never been
    // applied. Once `prisma migrate deploy` has run against a database, the
    // rewritten file no longer matches the recorded checksum and deployment
    // breaks — or worse, drifts. The compiler cannot see the database, so it
    // warns instead of refusing; docs/MIGRATIONS.md describes both workflows.
    if (action === "update" && file.path.startsWith("prisma/migrations/")) {
      warnings.push(
        `Migration ${file.path} changed because the specification changed. ` +
          "If this migration was already applied to a database, do NOT deploy the rewritten file: " +
          "reset development databases with `prisma migrate reset`, or create an incremental " +
          "migration for production (see docs/MIGRATIONS.md in the compiler repository).",
      );
    }

    planned.push({ path: file.path, action, ownership: file.ownership });
  }

  // Files the previous generation produced but this one does not.
  for (const entry of manifest?.files ?? []) {
    if (rendered.has(entry.path) || entry.ownership === "custom-scaffold") {
      continue;
    }

    const absolute = join(outputDirectory, entry.path.split("/").join(sep));
    const existing = await readIfPresent(absolute);

    if (existing === null) {
      continue;
    }

    if (hashContents(existing) !== entry.hash && !force) {
      warnings.push(
        `Keeping ${entry.path}: it is no longer generated, but it has local modifications.`,
      );
      continue;
    }

    planned.push({ path: entry.path, action: "delete", ownership: entry.ownership });
  }

  if (planned.some((file) => file.path === MANIFEST_PATH)) {
    warnings.push("A renderer produced the reserved generation manifest path; it will be ignored.");
  }

  return {
    files: planned.sort((left, right) => (left.path < right.path ? -1 : 1)),
    conflicts,
    warnings,
  };
}

export function summarizePlan(plan: GenerationPlan): Record<FileAction, number> {
  const summary: Record<FileAction, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    delete: 0,
    preserve: 0,
  };

  for (const file of plan.files) {
    summary[file.action] += 1;
  }

  return summary;
}
