import type { Issue } from "@backend-compiler/common";

/** Stable machine-readable failure codes for the MCP boundary. */
export const TOOL_ERROR_CODES = {
  invalidArguments: "tool.invalid-arguments",
  unknownTool: "tool.unknown",
  invalidSpec: "spec.invalid",
  generationFailed: "generation.failed",
  manifestMissing: "generation.manifest-missing",
  internal: "tool.internal",
} as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

export class ToolError extends Error {
  readonly issues: readonly Issue[];
  readonly code: ToolErrorCode;

  constructor(
    message: string,
    issues: readonly Issue[] = [],
    code: ToolErrorCode = TOOL_ERROR_CODES.invalidArguments,
  ) {
    super(message);
    this.name = "ToolError";
    this.issues = issues;
    this.code = code;
  }
}

/**
 * Upper bounds on agent-supplied strings. Paths longer than any real filesystem
 * path and names longer than any real identifier are rejected before they reach
 * the sandbox or the registries.
 */
const MAX_PATH_LENGTH = 4096;
const MAX_NAME_LENGTH = 200;

const SPEC_INPUT = {
  specPath: {
    type: "string",
    minLength: 1,
    maxLength: MAX_PATH_LENGTH,
    description: "Path to a YAML or JSON specification, inside an allowed root.",
  },
  spec: {
    type: "object",
    description: "The specification inline, as an object. Use this or specPath, not both.",
  },
} as const;

const EXACTLY_ONE_SPEC_INPUT = {
  oneOf: [
    { type: "object", properties: { specPath: {} }, required: ["specPath"] },
    { type: "object", properties: { spec: {} }, required: ["spec"] },
  ],
} as const;

const OUTPUT_PATH = {
  type: "string",
  minLength: 1,
  maxLength: MAX_PATH_LENGTH,
} as const;

/**
 * The single source of truth for the MCP tool surface. These schemas are both
 * advertised through tools/list and enforced at runtime against every call, so
 * the published contract and the validated contract cannot drift.
 */
export const TOOL_DEFINITIONS = [
  {
    name: "get_capabilities",
    description:
      "What this compiler can generate: specification version, targets, features and response limits. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_targets",
    description: "Backend targets this compiler can generate, with their supported databases.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_target",
    description: "Full detail for one target: databases, capabilities and project commands.",
    inputSchema: {
      type: "object",
      properties: { targetId: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH } },
      required: ["targetId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_features",
    description:
      "Feature packs available, with their dependencies and conflicts. Use describe_feature for the configuration schema.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_feature",
    description:
      "One feature's configuration JSON Schema, dependencies, conflicts and worked examples.",
    inputSchema: {
      type: "object",
      properties: { feature: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH } },
      required: ["feature"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_spec",
    description:
      "Validate a specification. Returns stable error codes and JSON pointers, so a failure can be fixed without guessing.",
    inputSchema: {
      type: "object",
      properties: SPEC_INPUT,
      ...EXACTLY_ONE_SPEC_INPUT,
      additionalProperties: false,
    },
  },
  {
    name: "inspect_spec",
    description:
      "Compile a specification and return the normalized backend IR: entities, endpoints, events, secrets and infrastructure.",
    inputSchema: {
      type: "object",
      properties: SPEC_INPUT,
      ...EXACTLY_ONE_SPEC_INPUT,
      additionalProperties: false,
    },
  },
  {
    name: "preview_generation",
    description:
      "Dry run: what generation would create, update, delete or refuse to overwrite. Writes nothing.",
    inputSchema: {
      type: "object",
      properties: { ...SPEC_INPUT, outputPath: OUTPUT_PATH },
      ...EXACTLY_ONE_SPEC_INPUT,
      required: ["outputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_backend",
    description:
      "Generate the backend. Refuses by default if a generated file was edited by hand; pass force to overwrite. Never overwrites src/custom/.",
    inputSchema: {
      type: "object",
      properties: {
        ...SPEC_INPUT,
        outputPath: OUTPUT_PATH,
        force: {
          type: "boolean",
          description: "Overwrite generated files that have local modifications.",
        },
      },
      ...EXACTLY_ONE_SPEC_INPUT,
      required: ["outputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "run_generated_tests",
    description:
      "Run the generated project's test suites and return counts, not logs. Integration tests need a reachable database.",
    inputSchema: {
      type: "object",
      properties: {
        outputPath: OUTPUT_PATH,
        install: { type: "boolean", description: "Install dependencies first." },
        integration: { type: "boolean", description: "Also run the integration suite." },
      },
      required: ["outputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "get_generation_report",
    description:
      "Read the generation manifest of an already-generated project: versions, checksums and file ownership.",
    inputSchema: {
      type: "object",
      properties: { outputPath: OUTPUT_PATH },
      required: ["outputPath"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_customization_points",
    description:
      "Where to put custom code for a specification, and which interface each extension point expects.",
    inputSchema: {
      type: "object",
      properties: SPEC_INPUT,
      ...EXACTLY_ONE_SPEC_INPUT,
      additionalProperties: false,
    },
  },
] as const;
