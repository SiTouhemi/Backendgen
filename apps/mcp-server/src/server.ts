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
      const result = await callTool(context, name, args);

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
                code: error.code,
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

      // Unexpected failures return a fixed message and never disclose the
      // original exception or its stack trace.
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            // Unexpected exceptions may contain absolute paths, dependency
            // details, or secret-bearing command output. Keep the public error
            // stable and disclose none of the original exception.
            text: serialize({
              success: false,
              code: "tool.internal",
              error: "Unexpected internal error",
            }),
          },
        ],
      };
    }
  });

  return server;
}
