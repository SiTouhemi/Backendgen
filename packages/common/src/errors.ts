export type IssueSeverity = "error" | "warning";

export interface Issue {
  /** Stable, machine-readable identifier, e.g. `feature.missing-dependency`. */
  code: string;
  /** JSON pointer into the specification, e.g. `/features/reservations/resource`. */
  path: string;
  message: string;
  severity: IssueSeverity;
}

export function issue(
  code: string,
  path: string,
  message: string,
  severity: IssueSeverity = "error",
): Issue {
  return { code, path, message, severity };
}

/**
 * Carries structured issues so that the CLI and the MCP server can render the
 * same failure without re-parsing an error message.
 */
export class CompilerError extends Error {
  readonly issues: readonly Issue[];

  constructor(message: string, issues: readonly Issue[]) {
    super(message);
    this.name = "CompilerError";
    this.issues = issues;
  }
}
