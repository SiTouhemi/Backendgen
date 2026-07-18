# AI builder integration

BackendGen is distributed as two local npm executables:

- `backendgen` is the human- and CI-facing CLI.
- `backendgen-mcp` exposes concise compiler tools to coding agents over stdio.

Both packages contain self-contained executables, require Node.js 22 or newer,
and generate source code that has no BackendGen runtime dependency. The npm
commands below become available after the first public release.

## Fastest local setup

```sh
npx -y backendgen init backend.yaml --name my-api
npx -y backendgen validate backend.yaml
npx -y backendgen generate backend.yaml --output ./backend
```

Give an MCP server only the directories it should access. Multiple roots use
the platform path delimiter (`:` on macOS/Linux and `;` on Windows).

```json
{
  "mcpServers": {
    "backendgen": {
      "command": "npx",
      "args": ["-y", "backendgen-mcp"],
      "env": {
        "BACKENDGEN_ALLOWED_ROOTS": "/absolute/path/to/projects"
      }
    }
  }
}
```

On native Windows clients that cannot launch `.cmd` shims directly, use
`"command": "cmd"` and start the arguments with `"/c", "npx"`.

## Codex and ChatGPT desktop

Codex CLI, the Codex IDE extension, and the ChatGPT desktop app share MCP
configuration. Add the local server with:

```sh
codex mcp add backendgen --env BACKENDGEN_ALLOWED_ROOTS=/absolute/path/to/projects -- npx -y backendgen-mcp
codex mcp list
```

Or add this to `~/.codex/config.toml` (personal) or `.codex/config.toml`
(trusted project):

```toml
[mcp_servers.backendgen]
command = "npx"
args = ["-y", "backendgen-mcp"]
env = { BACKENDGEN_ALLOWED_ROOTS = "/absolute/path/to/projects" }
startup_timeout_sec = 20.0
tool_timeout_sec = 120.0
```

For native Windows, use `command = "cmd"` and
`args = ["/c", "npx", "-y", "backendgen-mcp"]`. Restart the client and use
`/mcp` to verify the connection. This follows the official
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

The reusable Agent Skill is in `integrations/skills/backendgen`. Copy that
folder into `.agents/skills/backendgen` in a buyer's repository or into
`$HOME/.agents/skills/backendgen` for personal use. Invoke it with `$backendgen`.
Codex also discovers it implicitly when a task matches its description. See the
official [Agent Skills locations and format](https://learn.chatgpt.com/docs/build-skills).

## Claude Code and Cursor-style clients

Claude Code can register the same server at user or project scope:

```sh
claude mcp add backendgen --scope project \
  --env BACKENDGEN_ALLOWED_ROOTS=/absolute/path/to/projects \
  -- npx -y backendgen-mcp
```

On native Windows, use `-- cmd /c npx -y backendgen-mcp`. Other desktop coding
clients that accept the standard `mcpServers` JSON can use the generic example
above. Review and approve project-scoped MCP configuration before enabling it.

## Lovable and v0

Lovable Desktop supports local MCP servers, so it can use the stdio package
directly. Add a custom local server with the same command, arguments, and
allowed-root environment variable. Lovable's browser product and v0 accept
remote MCP connections, not a process running on the buyer's laptop.

Until a remote service passes local design-partner validation, use this safe
handoff for browser builders:

1. Let Lovable or v0 build the frontend and sync it to GitHub/local disk.
2. Run BackendGen locally or through the repository's BackendGen GitHub Action.
3. Commit the generated backend, `frontend-contract.json`, and typed client.
4. Point the frontend at the deployed API and set `CORS_ORIGINS` to its exact
   HTTPS origin.

Do not market the current stdio package as a direct v0 web integration. v0's
official [MCP documentation](https://api2.v0.dev/docs/MCP) describes hosted
bring-your-own servers; Lovable documents local MCP in its
[desktop app](https://docs.lovable.dev/integrations/desktop-app).

## GitHub Action

Once this repository is public, consumers can validate regeneration in CI:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - uses: OWNER/backend-compiler@v0.2.0
    with:
      spec: backend.yaml
      output: backend
      check: "true"
      run-tests: "true"
```

The action pins an exact npm package version, validates before generation, and
fails when committed generated files are stale. Replace `OWNER` only after the
final public repository owner is known.

## Frontend handoff contract

Every generated project includes `frontend-contract.json` and a zero-dependency
typed TypeScript client under `client/`. The contract is the small file an AI
frontend builder should read instead of scanning generated backend source. It
contains:

- the API base path, authentication mode, and organization header;
- API-visible entity fields, declared relations, and feature names;
- endpoint methods, paths, operation ids, authorization, and scopes;
- exact-origin CORS configuration requirements.

`CORS_ORIGINS` is optional and disabled when empty. It rejects wildcards,
credentials in URLs, paths, and non-HTTPS production origins. Browser clients
send bearer tokens through `Authorization`; cross-origin cookies are not
enabled.
