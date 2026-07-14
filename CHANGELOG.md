# Changelog

## 0.2.0 - Unreleased alpha

### Release-readiness pass

- Added `backendgen init` to scaffold a valid starter specification.
- Added a full specification reference, per-feature configuration docs, a customization walkthrough, and a migrations/schema-evolution guide (`docs/MIGRATIONS.md`).
- Added one complete example specification per end-to-end scenario (`examples/`).
- Pinned every direct dependency version in generated projects. The first install creates the lockfile that freezes the full transitive tree.
- Warn when a specification change rewrites an existing migration. A corrupt manifest now stops generation with one explicit ownership error instead of an untracked-file flood.
- Fixed generated-test execution on Windows when `npm_execpath` is unset (Node refuses to spawn `.cmd` shims without a shell).
- `backendgen test-generated` now forwards `DATABASE_URL` into the generated project; previously `db:validate` always failed from the CLI.
- Aligned relation-index validation with compiler ownership rules for `belongsTo`, `hasOne`, `hasMany`, inverse-name collisions, and `manyToMany`; `holdMinutes: 0` is accepted as immediate confirmation.
- Generated tenant-scoped CRUD tests now create real organization membership and keep required relation fixtures in the active tenant.
- Updated generated test projects to Jest 30 and added a disposable local PostgreSQL verifier for the complete six-scenario lifecycle.

- Added deterministic NestJS/Prisma/PostgreSQL repository generation.
- Added CRUD, authentication, organizations, reservations, and notifications feature packs.
- Added manifest-based safe regeneration and custom-code preservation.
- Added CLI discovery, validation, inspection, generation, diff, and generated-test commands.
- Added twelve local MCP tools with bounded responses and filesystem sandboxing.
- Added generated-project lifecycle tests, MCP protocol tests, target composition tests, CI, licensing, benchmarks, and open-source documentation.

All six generated-backend lifecycles pass locally against disposable PostgreSQL,
including migrations, concurrency and tenant-isolation tests. The release remains
alpha pending an independent generated-code security review.
