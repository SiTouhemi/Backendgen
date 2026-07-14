#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sandboxFromEnvironment } from "./sandbox.js";
import { createServer } from "./server.js";
import { createToolContext } from "./tools.js";

async function main(): Promise<void> {
  const sandbox = sandboxFromEnvironment();
  const server = createServer(createToolContext(sandbox));

  // stdio first: it needs no network listener and no credentials.
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`backendgen-mcp failed to start: ${message}\n`);
  process.exit(1);
});
