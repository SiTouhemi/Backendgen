# Backend Compiler

Backend Compiler is a local-first, deterministic backend generator for coding agents. An agent writes a compact `backendcompiler.dev/v1` YAML or JSON specification; the compiler validates it, creates framework-neutral IR, and generates a tested NestJS 11 + Prisma 6 + PostgreSQL repository.

Version 0.2.0 includes CRUD, authentication, organizations and tenant isolation, reservations with PostgreSQL overlap prevention, and notifications. It also provides the `backendgen` CLI and twelve MCP tools. FastAPI and hosted SaaS infrastructure are intentionally out of scope.

## Requirements

- Node.js 22+
- npm 10+
- PostgreSQL 16 for generated integration tests

## Quick start

```sh
npm ci
npm test
npm run validate:example
npm run generate:example
node apps/cli/dist/src/index.js test-generated --output generated/hotel-api --install
```

Use the built CLI directly when passing absolute paths; some npm 11 versions consume `--output` before forwarding arguments.

```sh
node apps/cli/dist/src/index.js generate examples/hotel-booking/backend.yaml --output /absolute/path/hotel-api --json
```

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile all workspaces with TypeScript project references. |
| `npm test` | Build and run unit, CLI, MCP, compiler, and rendering tests. |
| `npm run test:e2e` | Generate and regenerate all six scenario projects. Set `BACKENDGEN_E2E_BUILD=1` to install/build/test them. |
| `npm run licenses` | Regenerate the deterministic third-party license report. |
| `npm run benchmark:validate` | Validate benchmark result files without inventing measurements. |

For PostgreSQL-backed E2E, export `DATABASE_URL` and `BACKENDGEN_E2E_BUILD=1`. CI runs all six scenarios this way.

## Safety and customization

Generated files and user code are separated. Files marked `generated` in `.backendgen/manifest.json` are compiler-owned. Files marked `custom-scaffold` are written once and never overwritten. Generation refuses to replace locally modified generated files unless `--force` is explicit.

Start with [the architecture](docs/ARCHITECTURE.md), [specification](docs/SPECIFICATION.md), [feature packs](docs/FEATURE_PACKS.md), [target adapters](docs/TARGET_ADAPTERS.md), [MCP setup](docs/MCP.md), [threat model](docs/THREAT_MODEL.md), and [latest generated-code security review](docs/SECURITY_REVIEW_2026-07-14.md).

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
