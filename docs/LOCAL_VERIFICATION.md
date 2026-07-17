# Local verification record

Verified on 2026-07-17 on Windows with Node.js 22, npm 11, PostgreSQL 18
(disposable `initdb` clusters), and a native MinIO server (RELEASE.2025-09-07)
for real S3-compatible storage.

## Compiler and generator

- TypeScript project build (`npm run build`): passed.
- Unit and contract tests (`npm run test:unit`): 226/226 passed across 23 suites
  (includes the new manual-migration acceptance suite).
- `npm audit` (workspace, full and `--omit=dev`): 0 vulnerabilities.
- `git diff --check`: clean.

## Full-feature proof project

`generated/all-features-proof-20260717` is generated from
`examples/all-features/backend.yaml` — its exact, committed input. Observed:

- Regeneration into the existing directory: 0 created, 0 updated,
  140 unchanged, 4 preserved (byte-identical, custom code intact).
- An edit to `src/custom/custom.module.ts` survives regeneration verbatim.
- `npm audit` (generated project, full and production): 0 vulnerabilities.
- Prisma generate + validate: passed. Strict NestJS build: passed.
- Typed client build (`npm run build:client`): passed.
- Generated unit tests: 51/51 passed across 15 suites (includes the new
  storage startup-validation suite).
- Generated PostgreSQL integration tests: 56/56 passed across 15 suites
  against a fresh database with migrations deployed from zero.

## Quick-start boot and live HTTP smoke

The proof backend was booted with only the documented quick-start
configuration (`.env.example` values with secrets filled in), against a fresh
PostgreSQL database and a real local MinIO with the generated bucket
bootstrap. A 27-step HTTP smoke suite passed end to end:

- health `live`/`ready` 200; with the database stopped, `live` stays 200 and
  `ready` returns 503, recovering to 200 after restart
- register ×3, duplicate-register 409, wrong-password 401, unknown-email
  password reset accepted (anti-enumeration), `me`, refresh rotation with
  replayed-token rejection, register rate-limit 429 observed
- organization create + membership, tenant isolation for outsiders,
  member-role delete refusal, bounded pagination
- reservation availability, idempotency-key create + byte-identical replay,
  overlap 409, confirm
- webhook endpoint creation: HTTP refused, non-public DNS answers refused,
  public target accepted
- uploads against real MinIO: presigned PUT of exact bytes, replayed PUT to
  the same key refused with 412 (`If-None-Match: *`), server-side completion,
  presigned download returning the exact bytes, cross-tenant download refused

## Manual migration workflow (live)

Exercised with the CLI against a real database:

1. nullable→required change refused with an actionable
   `migrate.not-null-backfill-required` message pointing at `--accept-manual`;
2. hand-written backfill migration applied with `prisma migrate deploy`
   (column verified `NOT NULL` in PostgreSQL), then accepted with
   `--accept-manual`; the snapshot advanced and regeneration became a no-op;
3. editing the accepted migration afterwards fails
   `migrate.history-modified` even with `--force`;
4. a migration directory without `migration.sql` fails
   `migrate.history-missing`; removing it recovers cleanly.

## Generated-backend matrix

`scripts/verify-local.ps1` runs every end-to-end scenario against an isolated
disposable PostgreSQL cluster: generate, regenerate, install exact
dependencies, Prisma generate/validate, strict build, deploy migrations from
zero, run generated unit and integration suites, then discard the cluster and
project. All ten scenarios passed on 2026-07-17: basic-crud, file-uploads,
webhooks, webhooks-multitenant, background-jobs, authentication,
multi-tenant-saas, hotel-reservation, appointment-scheduling, all-features.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-local.ps1
```

## Known limitations of this verification

- Docker was not available on the verification host: the generated
  `docker-compose.yml` was structurally validated (YAML, service/volume
  wiring, pinned image tags confirmed present on Docker Hub) and its MinIO
  health-check URL and `mc mb` bootstrap command were exercised against a
  native MinIO binary, but `docker compose up` itself was not run.
- Storage behaviour is proven against MinIO and the AWS SigV4 known-answer
  vector only. AWS S3 and other S3-compatible providers were not exercised
  live; their `If-None-Match: *` support must be verified before adoption.
- The Resend notification provider was configured with a placeholder key for
  boot verification; live delivery goes through the mock/log paths in tests.
