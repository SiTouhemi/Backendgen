# Changelog

## 0.2.0 - Unreleased alpha

### Release-readiness pass

- Added `backendgen init` to scaffold a valid starter specification.
- Added a full specification reference, per-feature configuration docs, a customization walkthrough, and a migrations/schema-evolution guide (`docs/MIGRATIONS.md`).
- Added one complete example specification per end-to-end scenario (`examples/`).
- Pinned exact dependency versions for generated projects; two generations of the same specification now install the same tree.
- Warn when a specification change rewrites an existing migration, and when a manifest exists but is corrupt.
- Fixed generated-test execution on Windows when `npm_execpath` is unset (Node refuses to spawn `.cmd` shims without a shell).
- `backendgen test-generated` now forwards `DATABASE_URL` into the generated project; previously `db:validate` always failed from the CLI.
- Fixed spec validation rejecting indexes on relation foreign keys and `holdMinutes: 0`, both of which the compiler accepts.

- Added deterministic NestJS/Prisma/PostgreSQL repository generation.
- Added CRUD, authentication, organizations, reservations, and notifications feature packs.
- Added manifest-based safe regeneration and custom-code preservation.
- Added CLI discovery, validation, inspection, generation, diff, and generated-test commands.
- Added twelve local MCP tools with bounded responses and filesystem sandboxing.
- Added generated-project lifecycle tests, MCP protocol tests, target composition tests, CI, licensing, benchmarks, and open-source documentation.

This release remains alpha until the PostgreSQL CI matrix is green on the public repository.
