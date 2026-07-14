# MCP Server

Build with `npm run build`, then run `node apps/mcp-server/dist/src/index.js`. The server uses stdio and requires no account or network listener. Set `BACKENDGEN_ALLOWED_ROOTS` to one or more deliberate filesystem roots; the current directory is the default.

Generic configuration:

```json
{
  "command": "node",
  "args": ["C:/path/backend-compiler/apps/mcp-server/dist/src/index.js"],
  "env": { "BACKENDGEN_ALLOWED_ROOTS": "C:/path/projects" }
}
```

Use the same command/args/env object in Claude Code, Codex, Cursor, or another MCP client according to that client's MCP configuration format. Restart the client after editing its configuration.

The twelve tools discover capabilities, targets, and features; validate/inspect specs; preview/generate; run generated tests; read manifests; and explain customization. Responses never include generated file contents, secret values, or unbounded logs. Paths outside configured roots—including traversal and symlink/junction escapes—are rejected.
