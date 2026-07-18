# Support

BackendGen is an alpha maintained by one person. Support is best-effort through
GitHub issues on this repository.

- **Bug in the compiler, CLI, or MCP server** — open a bug report issue. Include
  a minimal specification that reproduces it; never include secrets, `.env`
  files, or private customer code.
- **Feature request** — open a feature request issue. Check
  [ROADMAP.md](ROADMAP.md) first.
- **Security vulnerability** — never open a public issue; follow
  [SECURITY.md](SECURITY.md).
- **Want to be a design partner** — open a design-partner interest issue; the
  program is described in [docs/DESIGN_PARTNERS.md](docs/DESIGN_PARTNERS.md).
- **Setting up with Claude Code, Codex, Cursor, Lovable, or v0** — see
  [docs/AI_BUILDERS.md](docs/AI_BUILDERS.md) and [docs/MCP.md](docs/MCP.md).
- **Contributing code** — see [CONTRIBUTING.md](CONTRIBUTING.md).

To reproduce from a clean checkout:

```sh
npm ci
npm run build
npm test
```

Generated applications are the operator's responsibility to review, secure,
and deploy; see the boundary in [SECURITY.md](SECURITY.md).
