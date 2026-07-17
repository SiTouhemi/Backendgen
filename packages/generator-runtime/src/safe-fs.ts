import { issue, type Issue } from "@backend-compiler/common";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Verifies that every path a generation is about to create, replace or delete
 * resolves to a location inside the output root, walking each path component
 * and refusing any symbolic link, Windows junction, or other reparse point.
 *
 * `assertSafeRelativePath` already rejects `..` and absolute paths as strings,
 * but a link planted *inside* the output directory would still redirect a
 * lexically safe path outside the root. Node reports Windows junctions as
 * symbolic links from `lstat`, so one check covers both platforms.
 *
 * The check runs immediately before writing. A link created in the window
 * between this check and the write is a local-attacker race this process
 * cannot fully close with portable Node APIs; the threat model here is
 * pre-existing links in an output directory the generator did not create.
 */
export async function findUnsafeOutputPaths(
  outputRoot: string,
  relativePaths: readonly string[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const verified = new Set<string>();

  for (const relativePath of relativePaths) {
    let current = outputRoot;

    for (const segment of relativePath.split("/")) {
      current = join(current, segment);
      if (verified.has(current)) continue;

      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code === "ENOENT") break; // Nothing exists from here down; mkdir will create real directories.
        issues.push(
          issue(
            "generate.unsafe-output-path",
            `/${relativePath}`,
            `Output path could not be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        break;
      }

      if (stats.isSymbolicLink()) {
        issues.push(
          issue(
            "generate.unsafe-output-path",
            `/${relativePath}`,
            "Output path passes through a symbolic link or junction inside the output directory. " +
              "Generation refuses to follow links out of the output root; remove the link and regenerate.",
          ),
        );
        break;
      }

      verified.add(current);
    }
  }

  return issues;
}
