import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Sandbox } from "./sandbox.js";
import { createServer } from "./server.js";
import { createToolContext } from "./tools.js";

const connected: Array<{ close(): Promise<void> }> = [];

async function protocol() {
  const root = await mkdtemp(join(tmpdir(), "backendgen-mcp-"));
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

describe("MCP protocol", () => {
  it("publishes the twelve concise tool contracts", async () => {
    const { client } = await protocol();
    const result = await client.listTools();
    expect(result.tools).toHaveLength(12);
    expect(result.tools.map((tool) => tool.name)).toContain("generate_backend");
  });

  it("executes every advertised tool through the official transport", async () => {
    const { client, root } = await protocol();
    const spec = {
      specVersion: "backendcompiler.dev/v1",
      project: { name: "all-tools" },
      target: { id: "nestjs-prisma", database: "postgresql" },
      entities: { Note: { fields: { title: "string" } } },
      features: { crud: {} },
    };
    const outputPath = join(root, "all-tools-project");
    const requests = [
      { name: "get_capabilities", arguments: {} },
      { name: "list_targets", arguments: {} },
      { name: "describe_target", arguments: { targetId: "nestjs-prisma" } },
      { name: "list_features", arguments: {} },
      { name: "describe_feature", arguments: { feature: "crud" } },
      { name: "validate_spec", arguments: { spec } },
      { name: "inspect_spec", arguments: { spec } },
      { name: "preview_generation", arguments: { spec, outputPath } },
      { name: "generate_backend", arguments: { spec, outputPath } },
      { name: "get_generation_report", arguments: { outputPath } },
      { name: "explain_customization_points", arguments: { spec } },
    ];
    for (const request of requests) {
      const result = await client.callTool(request);
      expect(result.isError, request.name).not.toBe(true);
      expect(JSON.stringify(result).length, request.name).toBeLessThan(64_000);
    }
    const tests = await client.callTool({
      name: "run_generated_tests",
      arguments: { outputPath },
    });
    expect(tests.isError).not.toBe(true);
    const testContent = (tests.content as Array<{ type: string; text?: string }>)[0];
    expect(JSON.parse(testContent?.text ?? "{}")).toMatchObject({ success: false });
  });

  it("returns structured validation failures without crashing", async () => {
    const { client } = await protocol();
    const result = await client.callTool({ name: "validate_spec", arguments: { spec: {} } });
    expect(result.isError).toBe(true);
    const content = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(content?.type).toBe("text");
    const payload = JSON.parse(content?.text ?? "{}");
    expect(payload).toMatchObject({ success: false });
    expect(payload.issues[0]).toEqual(expect.objectContaining({ code: expect.any(String), path: expect.any(String) }));
  });

  it("generates in its sandbox and never returns environment secret values", async () => {
    const { client, root } = await protocol();
    const secret = "DO-NOT-LEAK-THIS-VALUE";
    process.env.TEST_MCP_SECRET = secret;
    const spec = {
      specVersion: "backendcompiler.dev/v1",
      project: { name: "mcp-test" },
      target: { id: "nestjs-prisma", database: "postgresql" },
      entities: { Note: { fields: { title: "string" } } },
      features: { crud: {} },
    };
    const generated = await client.callTool({
      name: "generate_backend",
      arguments: { spec, outputPath: join(root, "project") },
    });
    expect(generated.isError).not.toBe(true);
    expect(JSON.stringify(generated)).not.toContain(secret);

    const denied = await client.callTool({
      name: "get_generation_report",
      arguments: { outputPath: "../outside" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("sandbox.denied");
    delete process.env.TEST_MCP_SECRET;
  });
});
