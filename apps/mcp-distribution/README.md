# BackendGen MCP

BackendGen MCP gives AI coding agents concise tools for discovering backend
features, validating a compact specification, previewing changes, generating a
tested NestJS/Prisma/PostgreSQL repository, and running its tests.

Configure an MCP client to run:

```json
{
  "command": "npx",
  "args": ["-y", "@2hemi/backendgen-mcp"],
  "env": {
    "BACKENDGEN_ALLOWED_ROOTS": "C:/path/to/projects"
  }
}
```

The server uses local stdio and requires no BackendGen account or network
listener. Responses contain concise summaries, counts, and bounded path lists;
they do not return generated source or environment-secret values. Filesystem
operations are restricted to `BACKENDGEN_ALLOWED_ROOTS`.

BackendGen MCP is licensed under Apache-2.0.
