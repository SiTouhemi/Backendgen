# Backend Compiler

Backend Compiler is a local-first, deterministic backend generator for coding agents. An agent writes a compact `backendcompiler.dev/v1` YAML or JSON specification; the compiler validates it, creates framework-neutral IR, and generates a tested NestJS 11 + Prisma 6 + PostgreSQL repository.

**Status: alpha.** Version 0.2 works locally and is verified by the test
matrix below, but it has not yet completed independent human security review or
design-partner trials. Generated applications require their own review before
production use. Real projects are welcome through the
[design-partner program](docs/DESIGN_PARTNERS.md); questions go through
[SUPPORT.md](SUPPORT.md).

Version 0.2.1 includes CRUD, authentication, organizations and tenant isolation,
reservations, notifications, webhooks, durable jobs, and presigned uploads. It
also provides publishable `@2hemi/backendgen` and `@2hemi/backendgen-mcp` packages, twelve
MCP tools, a generated frontend contract, and a reusable GitHub Action. FastAPI
and hosted SaaS infrastructure are intentionally out of scope.

## Requirements

- Node.js 22+
- npm 10+
- PostgreSQL 16+ server tools for generated integration tests

## Quick start

```sh
npm ci
npm test
npm run validate:example
npm run generate:example
npm run verify:local:postgres
```

`verify:local:postgres` creates and removes a disposable local database cluster.
It does not touch an existing PostgreSQL installation or application database.
For `test-generated`, export `DATABASE_URL` first; the command forwards it into
the generated project, and Prisma requires it even for schema validation.

Or start from scratch:

```sh
node apps/cli/dist/src/index.js init backend.yaml --name my-api
node apps/cli/dist/src/index.js generate backend.yaml --output ./my-api
```

After the first npm release, the same workflow is available without cloning
this monorepo:

```sh
npx -y @2hemi/backendgen init backend.yaml --name my-api
npx -y @2hemi/backendgen generate backend.yaml --output ./my-api
```

Before that release (for example as a design partner), install from packed
tarballs instead. In this repository run `npm run pack:distribution`, copy the
two `.tgz` files, then in any empty directory:

```sh
npm install ./2hemi-backendgen-0.2.1.tgz ./2hemi-backendgen-mcp-0.2.1.tgz
npx backendgen init backend.yaml --name my-api
```

See [examples/](examples/README.md) for a complete specification per feature combination.

Use the built CLI directly when passing absolute paths; some npm 11 versions consume `--output` before forwarding arguments.

```sh
node apps/cli/dist/src/index.js generate examples/hotel-booking/backend.yaml --output /absolute/path/hotel-api --json
```

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile all workspaces with TypeScript project references. |
| `npm test` | Build and run unit, CLI, MCP, compiler, and rendering tests. |
| `npm run test:fuzz` | Run the deterministic generated security contract (250 seeds locally; configurable for CI/replay). |
| `npm run test:fuzz:ci` | Run the complete 2,000-seed security contract in eight bounded shards. |
| `npm run test:e2e` | Generate and regenerate all ten scenario projects. Set `BACKENDGEN_E2E_BUILD=1` to install/build/test them. |
| `npm run licenses` | Regenerate the deterministic third-party license report. |
| `npm run benchmark:validate` | Validate benchmark result files without inventing measurements. |
| `npm run benchmark:expansion:check` | Reproduce the checked-in spec-to-repository expansion measurements. |
| `npm run test:distribution` | Pack, install, and smoke-test the public CLI and MCP packages as a consumer. |
| `npm run check:release` | Verify every version source and workflow file agrees; `-- --release` also requires `server.json`. |
| `npm run prepare:mcp-registry -- OWNER REPOSITORY` | Prepare final npm repository fields and official MCP Registry metadata. |

For repeatable PostgreSQL-backed E2E, run `npm run verify:local:postgres`. To
target an existing database instead, export `DATABASE_URL` and
`BACKENDGEN_E2E_BUILD=1` before `npm run test:e2e`.

## Safety and customization

Generated files and user code are separated. Files marked `generated` in `.backendgen/manifest.json` are compiler-owned. Files marked `custom-scaffold` are written once and never overwritten. Generation refuses to replace locally modified generated files unless `--force` is explicit.

Schema changes regenerate as incremental `ALTER` migrations on top of an
immutable history. Destructive drops are refused unless `--allow-destructive`
is explicit; data-dependent type changes and backfills require a reviewed
manual migration. See [migrations and schema evolution](docs/MIGRATIONS.md).

## Public contracts

Both public contracts ship as versioned JSON Schemas inside the `backendgen`
package: the `backendcompiler.dev/v1` specification and the generated
`backendcompiler.dev/frontend-contract/v1` file. Export either one for editors,
agents, or CI validation:

```sh
backendgen export-schema spec --output ./backend-spec.v1.schema.json
backendgen export-schema frontend --output ./frontend-contract.v1.schema.json
```

Without `--output` the schema prints to stdout. Every generated
`frontend-contract.json` is validated against the frontend schema in this
repository's scenario tests; the contract carries only client-facing shape and
never internal fields, secret names, or environment values.

Account verification/reset requires the notifications feature with a delivering `resend` or `custom` provider. The `log` provider is a metadata-only sink and intentionally never prints recipients, bodies, links, or tokens. Generated production recovery links require an HTTPS `APP_PUBLIC_URL`.

Start with [the architecture](docs/ARCHITECTURE.md), [specification reference](docs/SPECIFICATION.md), [feature packs](docs/FEATURE_PACKS.md), [customization](docs/CUSTOMIZATION.md), [migrations](docs/MIGRATIONS.md), [AI builder integration](docs/AI_BUILDERS.md), [generated security contract](docs/FUZZ_SECURITY_CONTRACT.md), [local release testing](docs/LOCAL_TESTING.md), [local verification record](docs/LOCAL_VERIFICATION.md), [target adapters](docs/TARGET_ADAPTERS.md), [MCP setup](docs/MCP.md), [threat model](docs/THREAT_MODEL.md), [latest generated-code security review](docs/SECURITY_REVIEW_2026-07-18.md), [commercialization boundary](docs/COMMERCIALIZATION.md), and [launch plan](docs/LAUNCH_PLAN.md). The dependency-free launch page lives in [site/](site/README.md).

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
