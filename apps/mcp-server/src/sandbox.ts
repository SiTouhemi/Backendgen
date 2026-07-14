import { isAbsolute, relative, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Every filesystem path an agent supplies is resolved and then checked to be
 * inside an allowed root. This is the only thing standing between a malicious or
 * confused specification and the rest of the machine, so it is deliberately
 * strict: symlink-free resolution, no `..` escapes, no cross-root access.
 */
export class Sandbox {
  readonly roots: string[];

  constructor(roots: readonly string[]) {
    if (roots.length === 0) {
      throw new SandboxError("At least one allowed root is required");
    }

    this.roots = roots.map((root) => realpathSync(resolve(root)));
  }

  /** Resolves `candidate` and fails unless it sits inside one of the roots. */
  resolveInside(candidate: string): string {
    if (candidate.trim() === "") {
      throw new SandboxError("Path must not be empty");
    }

    const absolute = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(this.roots[0] as string, candidate);

    // Canonicalize the closest existing ancestor. This catches symlink and
    // Windows junction escapes while still permitting a not-yet-created output
    // directory below a legitimate root.
    let ancestor = absolute;
    const suffix: string[] = [];
    while (!existsSync(ancestor)) {
      const parent = resolve(ancestor, "..");
      if (parent === ancestor) break;
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
    const canonical = resolve(realpathSync(ancestor), ...suffix);

    const contained = this.roots.some((root) => {
      const difference = relative(root, canonical);
      return (
        difference === "" ||
        (!difference.startsWith("..") && !isAbsolute(difference) && !difference.startsWith(`..${sep}`))
      );
    });

    if (!contained) {
      throw new SandboxError(
        `Path '${candidate}' is outside the allowed roots: ${this.roots.join(", ")}. ` +
          "Set BACKENDGEN_ALLOWED_ROOTS to widen access deliberately.",
      );
    }

    return canonical;
  }
}

export function sandboxFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Sandbox {
  const configured = environment.BACKENDGEN_ALLOWED_ROOTS;

  const roots =
    configured === undefined || configured.trim() === ""
      ? [process.cwd()]
      : configured
          .split(/[;:](?![\\/])/)
          .map((root) => root.trim())
          .filter((root) => root.length > 0);

  return new Sandbox(roots);
}
