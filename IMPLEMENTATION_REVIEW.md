# Backend Compiler Implementation Review

Audit date: 2026-07-14

## Implementation update

The completion pass added executable root E2E tests, deterministic license reporting, CLI subprocess coverage, MCP protocol and canonical sandbox tests, target composition conflict tests, a PostgreSQL CI matrix, a benchmark schema/validator, and open-source/security documentation. The six database-independent generated lifecycles pass, and a clean generated basic CRUD project installs, Prisma-validates, builds, and passes its generated unit suite on Windows.

PostgreSQL behavior remains pending execution because PostgreSQL/Docker is unavailable on this workstation. CI is configured to supply that evidence, but a workflow file is not itself proof of a green run. See `docs/RELEASE_CHECKLIST.md`.

This review compares the repository with the planned open-source alpha. A milestone is marked complete only when the implementation exists and its acceptance tests were run successfully.

## Verification performed

### Passed

- `npm install`: completed with zero reported vulnerabilities.
- `npm test`: 6 test files and 57 tests passed.
- TypeScript project build: passed through `npm test`.
- CLI target and feature discovery: passed.
- Hotel example generation: produced 87 files, 7 entities, and 25 endpoints.
- Clean generated-project dependency installation: passed.
- Generated Prisma client: passed.
- Generated Prisma schema validation with `DATABASE_URL`: passed.
- Generated NestJS build: passed.
- Generated hotel unit tests: 5 suites and 15 tests passed.
- CLI `test-generated`: reported 15/15 passing tests.

### Failed or unavailable

- `npm run test:e2e`: failed because `tests/e2e` contains no tests.
- `npm run licenses`: failed because `scripts/license-report.mjs` is missing.
- Docker/PostgreSQL integration execution: unavailable in the audit environment because Docker is not installed.
- Generated database migrations were not deployed to a real PostgreSQL instance.
- Generated integration suites for authentication, tenancy, CRUD, and reservation concurrency were not executed.

## Milestone status

| Milestone | Status | Evidence and required review |
|---|---|---|
| M0 Common package | Implemented and unit verified | Shared errors, hashes, strings, and versions compile and are consumed by the pipeline. |
| M1 Feature SDK | Implemented and unit verified | Registry, deterministic dependency ordering, missing dependencies, cycles, conflicts, configuration validation, target support, and entity requirements have 10 passing tests. |
| M2 Target SDK | Implemented, review required | Contracts and render context exist and compile. Add direct contract/registry tests and document adapter authoring. |
| M2b Extended IR and relations | Implemented and unit verified | Compiler tests cover normalization, inverse relation derivation, unknown relations, and feature entity contributions. |
| M3 NestJS/Prisma target | Implemented, integration review required | Hotel output installs, Prisma-validates, builds, and passes unit tests. Migration deployment, application startup, Docker Compose, OpenAPI runtime, and clean PostgreSQL integration remain unverified. |
| M4 CRUD pack | Implemented, integration review required | Renderer and generated unit tests exist. Actual REST CRUD, pagination, filtering, sorting, ownership, and soft-delete behavior must run against PostgreSQL. |
| M5 Auth pack | Implemented, security/integration review required | Registration, login, refresh rotation, logout, roles, guards, reset/verification foundations, throttling, and unit tests are generated. Full E2E flows and database behavior have not run. |
| M6 Organizations pack | Implemented, critical integration review required | Tenant entities, guards, services, and `tenant-isolation.e2e-spec.ts` are generated. Current root tests only inspect rendered strings; cross-tenant isolation has not been executed. |
| M7 Reservations pack | Implemented, critical concurrency review required | Holds, state transitions, idempotency, PostgreSQL exclusion constraint, expiry job, and concurrency test are generated. The exclusion migration and simultaneous booking test have not run on PostgreSQL. |
| M8 Notifications pack | Implemented and unit verified, integration review required | Provider interface, log/Resend/mock providers, listener, retry behavior, and unit tests exist. Event-to-provider integration in a running generated app remains unverified. |
| M9 Generator runtime | Implemented and unit verified | Compilation, rendering, manifest hashes, dry run, diff planning, force behavior, stale-file removal, custom-file preservation, and deterministic output have passing tests. |
| M10 CLI | Implemented, usability review required | Required commands exist. Relative output generation works. Absolute `--output` through `npm run cli --` can be consumed by npm 11; document/use the installed bin or fix the wrapper. Add CLI subprocess tests and output/exit-code assertions. |
| M11 MCP server | Implemented, protocol review required | Twelve tools and path sandboxing exist. There are no MCP protocol tests, tool-level tests, traversal tests, result-size tests, or secret-redaction tests. |
| M12 Scenarios and quality | Partially implemented | Six scenarios compile and render; determinism/regeneration tests pass. They do not generate, install, build, migrate, or execute generated integration tests. `test:e2e` is broken and CI is absent. |
| Benchmark harness | Missing | No benchmark directory, runner, methodology, or result templates exist. |
| Open-source readiness | Missing | Root README is stale. LICENSE, NOTICE, SECURITY, threat model, architecture, contribution guide, code of conduct, roadmap, changelog, third-party license report, and release documentation are absent. |

## Critical release blockers

1. Build a real E2E harness that generates clean projects and verifies them rather than inspecting rendered strings only.
2. Run PostgreSQL-backed tests for CRUD, authentication, tenant isolation, reservation migrations, and concurrent booking prevention.
3. Add CI with a PostgreSQL service so integration behavior is continuously verified even on machines without Docker.
4. Add MCP protocol and sandbox tests.
5. Fix `npm run test:e2e` and `npm run licenses`.
6. Add the benchmark harness without fabricating model results.
7. Complete open-source licensing, security, architecture, and contributor documentation.
8. Update the stale README to describe the actual 0.2.0 implementation.
9. Establish a clean Git baseline; all project files are currently untracked.

## Deferred by design

- FastAPI or any second target.
- SaaS infrastructure.
- Visual editor.
- Production hosting.
- Public feature marketplace.

These remain deferred until the NestJS/PostgreSQL alpha passes its release gates and design partners validate demand.
