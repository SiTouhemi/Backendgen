import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateToolArguments } from "./arguments.js";
import { TOOL_DEFINITIONS, TOOL_ERROR_CODES, ToolError } from "./definitions.js";
import { Sandbox } from "./sandbox.js";
import { createServer } from "./server.js";
import { createToolContext } from "./tools.js";

const connected: Array<{ close(): Promise<void> }> = [];

async function protocol() {
  const root = await mkdtemp(join(tmpdir(), "backendgen-mcp-args-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(createToolContext(new Sandbox([root])));
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push(client, server);
  return { client, root };
}

afterEach(async () => {
  await Promise.all(connected.splice(0).map((item) => item.close()));
});

interface ErrorPayload {
  success: boolean;
  code: string;
  error: string;
  issues?: Array<{ code: string; path: string; message: string }>;
}

async function callExpectingError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ErrorPayload> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `${name} should fail`).toBe(true);
  const content = (result.content as Array<{ type: string; text?: string }>)[0];
  const text = content?.text ?? "{}";
  expect(Buffer.byteLength(text, "utf8"), "error responses stay bounded").toBeLessThanOrEqual(
    64_000,
  );
  expect(text, "no stack traces cross the protocol boundary").not.toMatch(/\n\s+at /);
  return JSON.parse(text) as ErrorPayload;
}

describe("MCP runtime argument validation", () => {
  it("rejects explicit null instead of treating it as omitted arguments", () => {
    expect(() => validateToolArguments("get_capabilities", null)).toThrowError(ToolError);

    try {
      validateToolArguments("get_capabilities", null);
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe(TOOL_ERROR_CODES.invalidArguments);
      expect((error as ToolError).issues).toContainEqual(expect.objectContaining({ path: "/" }));
    }
  });

  it("escapes user-controlled property names as valid JSON Pointer segments", () => {
    try {
      validateToolArguments("get_capabilities", { "a/b~c": true });
      expect.unreachable("validation should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).issues).toContainEqual(
        expect.objectContaining({ path: "/a~1b~0c" }),
      );
    }
  });

  it("rejects unknown tool names with a stable code", async () => {
    const { client } = await protocol();
    const payload = await callExpectingError(client, "delete_everything", {});
    expect(payload).toMatchObject({ success: false, code: TOOL_ERROR_CODES.unknownTool });
  });

  const unknownPropertyCases = TOOL_DEFINITIONS.map((tool) => tool.name);

  it.each(unknownPropertyCases)(
    "rejects unknown properties for %s with a JSON-pointer path",
    async (name) => {
      const { client } = await protocol();
      const payload = await callExpectingError(client, name, { unexpectedExtra: 1 });
      expect(payload).toMatchObject({
        success: false,
        code: TOOL_ERROR_CODES.invalidArguments,
        error: "Tool arguments are invalid",
      });
      expect(payload.issues).toContainEqual(
        expect.objectContaining({
          code: TOOL_ERROR_CODES.invalidArguments,
          path: "/unexpectedExtra",
        }),
      );
    },
  );

  const malformedCases: Array<{
    title: string;
    name: string;
    args: Record<string, unknown>;
    path: string;
  }> = [
    { title: "missing required targetId", name: "describe_target", args: {}, path: "/targetId" },
    { title: "null targetId", name: "describe_target", args: { targetId: null }, path: "/targetId" },
    {
      title: "numeric feature name",
      name: "describe_feature",
      args: { feature: 42 },
      path: "/feature",
    },
    {
      title: "empty feature name",
      name: "describe_feature",
      args: { feature: "" },
      path: "/feature",
    },
    {
      title: "array where the spec object is expected",
      name: "validate_spec",
      args: { spec: [1, 2, 3] },
      path: "/spec",
    },
    {
      title: "string where the spec object is expected",
      name: "inspect_spec",
      args: { spec: "specVersion: backendcompiler.dev/v1" },
      path: "/spec",
    },
    {
      title: "missing required outputPath",
      name: "preview_generation",
      args: { spec: {} },
      path: "/outputPath",
    },
    {
      title: "boolean outputPath",
      name: "generate_backend",
      args: { outputPath: true },
      path: "/outputPath",
    },
    {
      title: "string force flag",
      name: "generate_backend",
      args: { outputPath: "api", force: "yes" },
      path: "/force",
    },
    {
      title: "oversized outputPath",
      name: "run_generated_tests",
      args: { outputPath: "x".repeat(5_000) },
      path: "/outputPath",
    },
    {
      title: "null outputPath",
      name: "run_generated_tests",
      args: { outputPath: null },
      path: "/outputPath",
    },
    {
      title: "object outputPath",
      name: "get_generation_report",
      args: { outputPath: { path: "api" } },
      path: "/outputPath",
    },
    {
      title: "oversized specPath",
      name: "explain_customization_points",
      args: { specPath: "y".repeat(5_000) },
      path: "/specPath",
    },
    {
      title: "non-string specPath",
      name: "validate_spec",
      args: { specPath: 7 },
      path: "/specPath",
    },
  ];

  it.each(malformedCases)("rejects $title before any tool logic runs", async ({ name, args, path }) => {
    const { client } = await protocol();
    const payload = await callExpectingError(client, name, args);
    expect(payload).toMatchObject({
      success: false,
      code: TOOL_ERROR_CODES.invalidArguments,
      error: "Tool arguments are invalid",
    });
    expect(payload.issues?.length).toBeGreaterThan(0);
    expect(payload.issues?.map((issue) => issue.path)).toContain(path);
    for (const issue of payload.issues ?? []) {
      expect(issue.code).toBe(TOOL_ERROR_CODES.invalidArguments);
      expect(issue.path.startsWith("/")).toBe(true);
    }
  });

  it("orders issues deterministically and deduplicates them", () => {
    let issues: ReadonlyArray<{ path: string }> = [];
    try {
      validateToolArguments("generate_backend", {
        spec: {},
        zebra: 1,
        alpha: 2,
        force: "yes",
      });
      expect.unreachable("validation should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      issues = (error as ToolError).issues;
    }
    const paths = issues.map((issue) => issue.path);
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths.map(String)).size).toBe(paths.length);
    expect(paths).toEqual(["/alpha", "/force", "/outputPath", "/zebra"]);
  });

  it("advertises and enforces exactly one of specPath or spec", async () => {
    const { client, root } = await protocol();
    const payload = await callExpectingError(client, "validate_spec", {
      spec: {},
      specPath: join(root, "backend.yaml"),
    });
    expect(payload.code).toBe(TOOL_ERROR_CODES.invalidArguments);
    expect(payload.error).toBe("Tool arguments are invalid");
    expect(payload.issues).toContainEqual(expect.objectContaining({ path: "/" }));

    const listed = await client.listTools();
    const validate = listed.tools.find((tool) => tool.name === "validate_spec");
    expect(validate?.inputSchema).toMatchObject({ oneOf: expect.any(Array) });
  });

  it("keeps sandbox denials stable and machine-readable", async () => {
    const { client, root } = await protocol();
    const payload = await callExpectingError(client, "get_generation_report", {
      outputPath: "../../outside",
    });
    expect(payload.code).toBe("sandbox.denied");
    expect(payload.error).not.toMatch(/\n\s+at /);
    expect(payload.error).not.toContain(root);
  });

  it("reports invalid specifications with spec.invalid and keeps serving", async () => {
    const { client } = await protocol();
    const payload = await callExpectingError(client, "validate_spec", { spec: {} });
    expect(payload.code).toBe(TOOL_ERROR_CODES.invalidSpec);
    expect(payload.issues?.length).toBeGreaterThan(0);

    // The server survives the malformed call and still answers correctly.
    const capabilities = await client.callTool({ name: "get_capabilities", arguments: {} });
    expect(capabilities.isError).not.toBe(true);
  });

  it("advertises exactly the schemas it enforces", async () => {
    const { client } = await protocol();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      TOOL_DEFINITIONS.map((tool) => tool.name).sort(),
    );
    for (const tool of listed.tools) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === tool.name);
      expect(tool.inputSchema).toEqual(definition?.inputSchema);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});
