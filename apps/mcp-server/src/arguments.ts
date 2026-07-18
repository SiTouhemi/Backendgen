import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { Issue } from "@backend-compiler/common";
import { TOOL_DEFINITIONS, TOOL_ERROR_CODES, ToolError } from "./definitions.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });

const validators: ReadonlyMap<string, ValidateFunction> = new Map(
  TOOL_DEFINITIONS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);

function issueFromError(error: ErrorObject): Issue {
  let path = error.instancePath;

  const pointerSegment = (value: unknown): string =>
    String(value).replaceAll("~", "~0").replaceAll("/", "~1");

  if (error.keyword === "required" && "missingProperty" in error.params) {
    path = `${path}/${pointerSegment(error.params.missingProperty)}`;
  } else if (error.keyword === "additionalProperties" && "additionalProperty" in error.params) {
    path = `${path}/${pointerSegment(error.params.additionalProperty)}`;
  }

  return {
    code: TOOL_ERROR_CODES.invalidArguments,
    path: path === "" ? "/" : path,
    message: error.message ?? "Invalid value",
    severity: "error",
  };
}

function deterministic(issues: Issue[]): Issue[] {
  const seen = new Set<string>();

  return issues
    .sort((left, right) =>
      left.path === right.path
        ? left.message.localeCompare(right.message)
        : left.path.localeCompare(right.path),
    )
    .filter((issue) => {
      const key = `${issue.path}\u0000${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Enforces, at runtime, exactly the JSON Schema each tool advertises through
 * tools/list. Unknown tools and malformed arguments fail with stable codes and
 * JSON-pointer paths before any tool logic, sandbox resolution, or filesystem
 * access runs.
 */
export function validateToolArguments(name: string, args: unknown): Record<string, unknown> {
  const validator = validators.get(name);

  if (validator === undefined) {
    throw new ToolError(
      `Unknown tool '${name}'. Available: ${TOOL_DEFINITIONS.map((tool) => tool.name).join(", ")}`,
      [],
      TOOL_ERROR_CODES.unknownTool,
    );
  }

  // MCP permits omitting `arguments` for no-argument tools. Explicit null is a
  // value, however, and must be rejected because every advertised schema has
  // `type: object`.
  const candidate = args === undefined ? {} : args;

  if (!validator(candidate)) {
    throw new ToolError(
      "Tool arguments are invalid",
      deterministic((validator.errors ?? []).map(issueFromError)),
      TOOL_ERROR_CODES.invalidArguments,
    );
  }

  return candidate as Record<string, unknown>;
}
