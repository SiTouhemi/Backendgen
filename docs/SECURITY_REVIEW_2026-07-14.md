# Generated-Code Security Review — 2026-07-14

## Outcome

The review found and fixed six high/critical trust-boundary defects plus several
medium hardening and reliability issues. No known critical or high-severity
finding remains in the reviewed generator paths. This is not a production
security certification: PostgreSQL-backed integration and concurrency tests
still need independent CI evidence before release.

## Scope and method

Reviewed code paths:

- NestJS/Express bootstrap, validation, error handling, environment loading,
  Dockerfile, and Compose output.
- Authentication, refresh rotation, password reset, email verification, JWT,
  throttling, and password hashing.
- Organization context, role validation, tenant membership, and last-owner
  invariants.
- Generic CRUD filters, pagination, writes, relation validation, ownership, and
  tenant scoping.
- Reservation idempotency, state transitions, hold expiry, availability, and
  database overlap enforcement.
- Notification logging, retry behavior, secret-bearing messages, and outbound
  HTTP calls.
- MCP filesystem/test-execution boundary and generation-manifest parsing.

The review used source tracing through the existing Graphify graph, targeted
manual data-flow review, repository-wide sink searches, TypeScript compilation,
unit/rendering regression tests, dependency audits, and a clean generated
all-features lifecycle build.

## Fixed findings

| ID | Severity | Finding | Resolution and evidence |
|---|---:|---|---|
| SEC-001 | Critical | A globally unique reservation idempotency key was replayed with an unscoped lookup, allowing a caller who knew another key to receive that reservation. | Replay and unique-race recovery now use owner/tenant `scopedWhere`; foreign keys and keys are bounded. See `features/reservations/src/render.ts`. |
| SEC-002 | High | Two concurrent refreshes could both issue valid replacement sessions before the old session was revoked. | Rotation now atomically claims the old session with `updateMany` inside a transaction and revokes the family on a lost/reused claim (`features/auth/src/render.ts:168`). |
| SEC-003 | High | Password-reset and email-verification tokens were checked and consumed in separate writes, allowing concurrent reuse. | Consumption is an atomic conditional claim in the same transaction as the account update (`features/auth/src/render.ts:575`, `features/auth/src/render.ts:647`). |
| SEC-004 | High | A tenant-scoped CRUD row could reference a related row belonging to another tenant. | Generated services validate protected related records against soft-delete, tenant, and owner scope before create/update (`features/crud/src/render.ts:531`). |
| SEC-005 | High | The final organization owner could be demoted, and concurrent owner removals could violate the invariant. | Demotion/removal now run in retrying serializable transactions and check the owner count (`features/organizations/src/render.ts:377`, `features/organizations/src/render.ts:447`). |
| SEC-006 | High | `run_generated_tests` could execute package scripts in any directory accepted by the MCP root sandbox. | The runner now requires a structurally valid backendgen manifest, canonical in-root files, compiler ownership of `package.json`, and matching hashes for every generated file before execution (`packages/generator-runtime/src/run-tests.ts:58`). |
| SEC-007 | Medium | Notification providers and retry logs exposed recipients, message bodies, reset tokens, and upstream error bodies; outbound HTTP had no timeout. | Logging is metadata-only, Resend responses are not copied into errors, requests time out after 10 seconds, and permanent 4xx failures are not retried (`features/notifications/src/render.ts:28`, `features/notifications/src/render.ts:165`). |
| SEC-008 | Medium | Generated Express apps lacked explicit security headers/body limits; production Swagger exposure and proxy trust were implicit; error logs included query strings. | Added Helmet, explicit JSON/form limits, disabled `x-powered-by`, strict proxy-hop configuration, production-off Swagger, and query-free error paths (`targets/nestjs-prisma/src/project.ts:179`, `targets/nestjs-prisma/src/project.ts:423`, `targets/nestjs-prisma/src/project.ts:460`). |
| SEC-009 | Medium | Reservation confirm/cancel used read-then-unconditional-update transitions, and expiry scanned all expired rows. | Transitions use conditional `updateManyAndReturn`; expiry works in bounded batches and only emits events for rows actually updated (`features/reservations/src/render.ts:498`, `features/reservations/src/render.ts:567`). |
| SEC-010 | Medium | Generated containers ran as root, Compose mixed migrations into API startup, and emitted predictable database credentials. | Runtime uses `USER node`; Compose uses a one-shot migration service, read-only API filesystem, dropped capabilities, `no-new-privileges`, and a required database password (`targets/nestjs-prisma/src/project.ts:572`, `targets/nestjs-prisma/src/project.ts:602`). |
| SEC-011 | Low | Invalid boolean filters became `false`; search, identifiers, and page offsets were insufficiently bounded. | Invalid booleans remain invalid, strings/IDs are bounded, and pages have a maximum (`features/crud/src/render.ts:182`, `features/crud/src/render.ts:199`, `targets/nestjs-prisma/src/project.ts:275`). |

Additional hardening includes a JWT `HS256` verification allowlist, minimal JWT
payloads, email normalization, bcrypt's 72-byte ceiling, closed organization
role validation, and a fail-closed organization guard.

## Verification evidence

- `npm test`: 11 files, 77 tests passed.
- `npm run build`: all TypeScript project references passed.
- `npm audit --audit-level=high`: zero vulnerabilities in the compiler workspace.
- Clean `all-features` generated lifecycle with `BACKENDGEN_E2E_BUILD=1`:
  generation, regeneration, manifest verification, dependency installation,
  Prisma generation, Prisma schema validation, Nest build, and generated unit
  tests passed.
- The clean generated install also reported zero npm vulnerabilities.
- Regression tests assert bootstrap hardening, atomic auth behavior, serializable
  owner invariants, scoped idempotency, secret-free notification logs,
  tenant-safe relations, container controls, and test-runner preflight.

## Residual risks and required release work

1. **PostgreSQL execution is still unverified locally.** Docker/PostgreSQL is not
   installed on this workstation, so migrations, REST integration suites,
   tenant isolation, token races, and reservation overlap concurrency were not
   executed against a real database. Require a green public CI run before release.
2. **Rate limiting is process-local.** A multi-instance deployment needs a shared
   Nest throttler store and exact `TRUST_PROXY_HOPS` configuration.
3. **Test execution remains a code-execution feature by design.** Manifest checks
   prevent accidental/arbitrary directories and post-generation edits, but the
   manifest is not signed. MCP allowed roots and editable custom code remain
   trusted operator boundaries.
4. **Compose is a development baseline.** Production must pin images by digest,
   use managed secrets and least-privilege database credentials, terminate TLS,
   restrict networks, and provide backups/monitoring.
5. **Swagger UI relaxes CSP only when explicitly enabled.** Keep it disabled in
   production or protect it at the edge.
6. **Custom code is outside generator guarantees.** Re-run application-specific
   authorization, privacy, abuse, and dependency review after adding providers
   or business rules.

## Release decision

The compiler is suitable for continued alpha testing and public source review.
Do not describe generated applications as production-ready until the database
integration/concurrency matrix is green and an independent reviewer confirms
the fixed authorization and state-transition paths.
