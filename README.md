# BackendGen

**BackendGen is a deterministic backend compiler for AI coding agents.** Give an
agent a compact, versioned YAML or JSON specification and it can generate a
structured, tested backend instead of inventing database models, permissions,
API routes, and migrations from scratch.

It currently generates **NestJS 11 + Prisma 6 + PostgreSQL** repositories,
including a typed TypeScript client and a small `frontend-contract.json` for
the frontend agent to consume. Generated projects have no BackendGen runtime
dependency.

> **Alpha status:** BackendGen is ready for design-partner trials and local
> projects. Review generated applications before production use; it has not yet
> completed independent security review or three design-partner trials.

[npm CLI](https://www.npmjs.com/package/@2hemi/backendgen) ·
[npm MCP server](https://www.npmjs.com/package/@2hemi/backendgen-mcp) ·
[Report an issue](https://github.com/SiTouhemi/Backendgen/issues) ·
[Design-partner program](docs/DESIGN_PARTNERS.md)

## What it is for

BackendGen is useful when an AI agent needs a real backend behind a frontend:

- model entities, relations, filters, sorting, and pagination;
- add authentication, roles, row ownership, organizations, and tenant isolation;
- generate reservations, notifications, webhooks, durable jobs, and uploads;
- preserve a clean boundary between compiler-owned code and application-owned
  custom code;
- safely regenerate after a specification changes, with incremental migrations
  and explicit review gates for destructive changes.

BackendGen is **not** a hosted backend service, deployment platform, or
frontend builder. It runs locally and produces code that a developer or coding
agent can review, customize, test, deploy, and connect to a frontend.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- PostgreSQL only when you want to run a generated project's integration tests

## Try it in five minutes

You do not need an npm account or this repository to try BackendGen.

```sh
mkdir backendgen-try
cd backendgen-try

npx -y @2hemi/backendgen init backend.yaml --name team-api
npx -y @2hemi/backendgen validate backend.yaml
npx -y @2hemi/backendgen generate backend.yaml --output ./team-api

cd team-api
npm install
npm test
```

`init` creates a valid starter specification. Edit `backend.yaml`, then run
`validate` and `generate` again. Before regenerating an existing project, use
`diff` to preview what would change:

```sh
npx -y @2hemi/backendgen diff backend.yaml --output ./team-api
```

## Test a complete SaaS example

The repository includes working specifications from basic CRUD to a
full-featured backend. This multi-tenant task example is a good first test:

```sh
git clone https://github.com/SiTouhemi/Backendgen.git
cd Backendgen

npx -y @2hemi/backendgen validate examples/saas-tasks/backend.yaml
npx -y @2hemi/backendgen generate examples/saas-tasks/backend.yaml --output ./generated/saas-tasks

cd generated/saas-tasks
npm install
npm test
```

Browse every example and what it demonstrates in [examples/README.md](examples/README.md):

| Example | Demonstrates |
|---|---|
| [notes API](examples/notes-api/backend.yaml) | CRUD, filtering, pagination, and sorting |
| [auth notes](examples/auth-notes/backend.yaml) | Accounts, roles, ownership, and authentication |
| [SaaS tasks](examples/saas-tasks/backend.yaml) | Organizations and enforced tenant isolation |
| [hotel booking](examples/hotel-booking/backend.yaml) | Reservations, overlap prevention, and notifications |
| [all features](examples/all-features/backend.yaml) | CRUD, auth, organizations, reservations, notifications, webhooks, jobs, and uploads |

## Use it with an AI coding agent (MCP)

The MCP package lets an AI agent discover supported backend features, validate
a spec, preview changes, generate a backend, run generated tests, and explain
customization points. It runs locally over stdio—no BackendGen account or
network listener is required.

Add this server to an MCP-capable client, giving it only a directory you trust:

```json
{
  "mcpServers": {
    "backendgen": {
      "command": "npx",
      "args": ["-y", "@2hemi/backendgen-mcp"],
      "env": {
        "BACKENDGEN_ALLOWED_ROOTS": "/absolute/path/to/projects"
      }
    }
  }
}
```

For Codex, Claude Code, Cursor, ChatGPT desktop, Windows, Lovable Desktop, and
the correct v0 handoff, follow the client-specific commands in
[docs/AI_BUILDERS.md](docs/AI_BUILDERS.md). The complete MCP security and tool
reference is in [docs/MCP.md](docs/MCP.md).

Once connected, give your agent a request such as:

> Create a multi-tenant task-management backend. First inspect BackendGen's
> capabilities and relevant features. Write a spec, validate it, preview the
> generation, generate it inside this project, and run the generated tests.
> Keep custom behavior in the documented customization points.

## What is generated

For a valid specification, BackendGen produces a standalone repository with:

- a NestJS API, Prisma schema, PostgreSQL migrations, OpenAPI setup, and tests;
- generated endpoints and permission rules derived from the normalized spec;
- `src/generated/` for compiler-owned code and `src/custom/` for code you own;
- a `.backendgen/manifest.json` that records ownership and hashes;
- `frontend-contract.json` and a typed TypeScript client for frontend agents.

On regeneration, BackendGen preserves custom files, refuses to overwrite edited
generated files unless you explicitly use `--force`, and requires explicit
review for destructive or data-dependent schema changes. Read
[docs/MIGRATIONS.md](docs/MIGRATIONS.md) before changing a live schema.

## Verification and limits

The repository's CI verifies compiler, CLI, MCP, security-contract fuzzing,
package-installation, and generated-project scenarios. Generated projects are
also built and tested against PostgreSQL in the release test matrix. See the
[local verification record](docs/LOCAL_VERIFICATION.md) and
[security contract](docs/FUZZ_SECURITY_CONTRACT.md) for the exact evidence.

That evidence does **not** prove that every generated application is safe for
production. You remain responsible for reviewing the specification, generated
code, secrets, infrastructure, and deployment configuration.

Current boundaries:

- one production target: NestJS + Prisma + PostgreSQL;
- FastAPI and other backend targets are intentionally out of scope;
- no hosted BackendGen SaaS or direct browser-v0 MCP integration yet;
- do not make token-savings claims until the paired benchmark has real results.

## Documentation

| If you need to… | Read |
|---|---|
| Write a specification | [Specification reference](docs/SPECIFICATION.md) |
| Understand each supported feature | [Feature packs](docs/FEATURE_PACKS.md) |
| Connect an AI agent or MCP client | [AI builder integration](docs/AI_BUILDERS.md) |
| Customize a generated project | [Customization guide](docs/CUSTOMIZATION.md) |
| Safely regenerate or change a schema | [Migrations guide](docs/MIGRATIONS.md) |
| Run tests locally | [Local testing](docs/LOCAL_TESTING.md) |
| Understand security boundaries | [Threat model](docs/THREAT_MODEL.md) |
| Contribute | [Contributing](CONTRIBUTING.md) |

## Feedback and support

We are looking for developers and AI builders who will test BackendGen on a
real, non-production project. Please open an issue with:

1. what you were trying to build;
2. your sanitized `backend.yaml` specification;
3. the command or MCP client you used;
4. what worked, what was confusing, and what you expected instead.

Never include API keys, `.env` files, private customer code, or production
database data. For security vulnerabilities, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue. Full support details are in [SUPPORT.md](SUPPORT.md).

## Development

To work on BackendGen itself:

```sh
npm ci
npm test
npm run test:fuzz:ci
npm run test:e2e
npm run test:distribution
```

BackendGen is licensed under [Apache-2.0](LICENSE). Generated projects belong
to their users.
