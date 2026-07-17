import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GENERATOR_VERSION } from "@backend-compiler/common";
import { SandboxError } from "./sandbox.js";
import { callTool, TOOL_DEFINITIONS, ToolError, type ToolContext } from "./tools.js";

/** Upper bound on a single tool response, so one call cannot flood an agent's context. */
const MAX_RESPONSE_BYTES = 64_000;

function serialize(value: unknown): string {
  const text = JSON.stringify(value, null, 2);

  if (Buffer.byteLength(text, "utf8") <= MAX_RESPONSE_BYTES) {
    return text;
  }

  return JSON.stringify(
    {
      truncated: true,
      message: `The response exceeded ${MAX_RESPONSE_BYTES} bytes and was withheld. Narrow the request.`,
    },
    null,
    2,
  );
}

export function createServer(context: ToolContext): Server {
  const server = new Server(
    { name: "backendgen", version: GENERATOR_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await callTool(context, name, (args ?? {}) as Record<string, unknown>);

      return {
        content: [{ type: "text" as const, text: serialize(result) }],
      };
    } catch (error) {
      // Failures are returned as structured tool errors rather than protocol
      // errors, so an agent can read the codes and fix its specification.
      if (error instanceof ToolError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: serialize({
                success: false,
                error: error.message,
                issues: error.issues,
              }),
            },
          ],
        };
      }

      if (error instanceof SandboxError) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: serialize({ success: false, error: error.message, code: "sandbox.denied" }),
            },
          ],
        };
      }

      const message = error instanceof Error ? error.message : String(error);

      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: serialize({ success: false, error: message }),
          },
        ],
      };
    }
  });

  return server;
}
