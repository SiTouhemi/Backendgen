# MCP Server

After the first public release, run the self-contained package with
`npx -y @2hemi/backendgen-mcp`. A complete client-by-client guide is in
[AI builder integration](AI_BUILDERS.md).

Build with `npm run build`, then run `node apps/mcp-server/dist/src/index.js`. The server uses stdio and requires no account or network listener. Set `BACKENDGEN_ALLOWED_ROOTS` to one or more deliberate filesystem roots; the current directory is the default. Separate multiple roots with `;` on any platform, or `:` between POSIX absolute paths (on Windows, `:` followed by `\` or `/` is treated as a drive letter, not a separator).

Generic configuration:

```json
{
  "command": "node",
  "args": ["C:/path/backend-compiler/apps/mcp-server/dist/src/index.js"],
  "env": { "BACKENDGEN_ALLOWED_ROOTS": "C:/path/projects" }
}
```

Published-package configuration:

```json
{
  "command": "npx",
  "args": ["-y", "@2hemi/backendgen-mcp"],
  "env": { "BACKENDGEN_ALLOWED_ROOTS": "C:/path/projects" }
}
```

Use the same command/args/env object in Claude Code, Codex, Cursor, or another MCP client according to that client's MCP configuration format. Restart the client after editing its configuration.

The twelve tools discover capabilities, targets, and features; validate/inspect specs; preview/generate; run generated tests; read manifests; and explain customization. Responses never include generated file contents, secret values, configured host-root paths, internal exception details, or unbounded logs. Paths outside configured roots—including traversal and symlink/junction escapes—are rejected.
