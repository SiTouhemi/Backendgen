# Changelog

## 0.2.0 - Unreleased alpha

### Release blockers closed (2026-07-17)

- Initial PostgreSQL migrations are atomic (`BEGIN`/`COMMIT`), arbitrary column
  type conversions now fail closed into the reviewed manual-migration workflow,
  and `backendgen diff` exposes the exact pending SQL in both human and JSON
  output.
- Generated READMEs now state when a valid external Resend key or custom
  notification provider is required; the full-feature quick start no longer
  implies that Compose provisions notification delivery.

- Manual migration completion: new `--accept-manual <migration-dir>` option on `generate`/`diff` records a reviewed hand-written migration as implementing the entire pending schema transition (nullable→required backfills, feature-SQL removal, non-tail enum changes). Acceptance validates the directory, refuses generator-owned/already-recorded/out-of-order/incomplete migrations, advances the snapshot only on success, and binds the migration and both snapshots by SHA-256 into the manifest and `.backendgen/accepted-migrations.json`. Accepted files are immutable history: edits, deletion, or record tampering fail closed even with `--force`. Refusal messages now point to the workflow. See `docs/MIGRATIONS.md`.
- Untracked files that are byte-identical to the rendered output are now adopted into the manifest instead of reported as conflicts.
- Reproducible proof input: `examples/all-features/backend.yaml` enables every
  feature pack; clean generation is idempotent, while retained proof projects
  preserve their immutable migrations and custom code.
- Working uploads quick start: generated `docker-compose.yml` now includes a pinned MinIO service with a health check plus a one-shot bucket-bootstrap service; `.env.example` carries a complete, working local `S3_*` configuration; the README documents production requirements, the `If-None-Match: *` conditional-write dependency, and static-credential limitations. A generated `uploads-startup.spec.ts` asserts that the documented configuration boots and that unsafe or incomplete configurations fail with actionable errors. The mock storage provider remains test-only.

### Feature expansion

- Incremental migrations: generation records a schema snapshot and emits ordered `ALTER` migrations for specification changes instead of rewriting applied history. Additive changes are automatic, required columns demand a backfill default (`migrate.not-null-requires-default`), and destructive statements are refused without `--allow-destructive`, then emitted with explicit `-- DESTRUCTIVE:` labels. Enum additions are isolated in a non-transactional trailing section.
- Deterministic development seeds: generated projects gain `prisma/seed.ts` and `npm run db:seed` — content-addressed ids, constraint-respecting values, upsert-only writes, tenant-distributed rows, and an integration test proving determinism and idempotence.
- Typed API client: every generated project ships a zero-dependency `client/` package built from the same model as the server (CRUD resources, auth with rotation, tenant scoping via `withOrganization`, reservations with idempotency keys, structured `ApiRequestError`). `npm run build:client` compiles it standalone; a generated e2e suite drives the live HTTP server through the client. Disable with `options.client: false`.

### Release-readiness pass

- Added explicit `restrict` / `cascade` / `setNull` relation semantics, deterministic PostgreSQL-safe constraint names, automatic foreign-key indexes, UTC `TIMESTAMPTZ(3)` columns, and Prisma/DDL parity tests.
- Hardened destructive CRUD routes with validated account/organization role policies, fail-closed guards, PostgreSQL `RESTRICT` conflict mapping, PATCH persistence coverage, stable pagination tie-breakers, bounded configured page sizes, and accurate paginated OpenAPI schemas.
- Made account registration/session creation atomic, password reset/session revocation transactional, recovery requests enumeration-resistant, and every auth path reject soft-deleted accounts.
- Added automatic recovery notifications with validated public links and delivering-provider validation. Production recovery links require HTTPS; the metadata-only log provider cannot satisfy recovery delivery.
- Added a transactional PostgreSQL notification outbox with leased `SKIP LOCKED` dispatch, bounded persisted retry/backoff, terminal payload clearing, soft-deleted-recipient exclusion, and real-database integration coverage. Custom providers are supported through `CustomModule`; the mock provider is test-only.
- Scoped reservation idempotency by owner/tenant and canonical request fingerprint, validated resources before policy/cleanup, drained all expired-hold batches, made availability reject missing resources, and aligned no-hold IR with the emitted API.
- Split liveness from database readiness, added readiness/OpenAPI integration tests, and enabled strict generated-project TypeScript across feature combinations.
- The test-only mock provider now takes precedence over a registered custom provider under `NODE_ENV=test`, so generated integration tests stay hermetic in projects that ship their own transport.
- Deduplicated destructive-role validation when `destructiveRoles` inherits `adminRoles`, and repaired the auth-role validation type error.
- Verified the complete coworking proof project on Windows against real PostgreSQL: strict build, 33 unit and 33 integration tests, six-scenario matrix, byte-identical custom code across regeneration, zero `npm audit` findings, and a 40-step live HTTP flow covering recovery links, idempotency, overlap races, hold expiry, destructive-role refusal, tenant isolation, and 503 readiness during a database outage.

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

All ten generated-backend lifecycles pass locally against disposable PostgreSQL,
including migrations, concurrency and tenant-isolation tests. The release remains
alpha pending an independent generated-code security review.
