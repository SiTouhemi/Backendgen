# Local verification record

Verified on 2026-07-14 on Windows with Node.js 22, npm 11, and PostgreSQL 18.

## Compiler and generator

- TypeScript project build: passed.
- Unit and contract tests: 93/93 passed across 11 suites.
- All six example specifications: valid.
- Generated direct dependencies: exact versions.
- High-severity dependency audit: 0 vulnerabilities.

## Generated-backend matrix

All six scenarios completed a clean generated-project lifecycle against an
isolated disposable PostgreSQL database:

- basic CRUD
- authentication and row ownership
- multi-tenant SaaS
- hotel reservations
- appointment scheduling
- all features combined

Each lifecycle generated and regenerated the project, installed dependencies,
generated and validated Prisma, built NestJS, deployed the migration, and ran
the generated unit and integration suites. The database cluster and generated
test project were removed after each run.

## Retained demonstration backend

`generated/local-demo-api` was generated from
`examples/desk-booking/backend.yaml` and intentionally retained for inspection.
It contains 97 generated files, 9 entities, 32 endpoints, and all five feature
packs. Its observed results were:

- Prisma schema validation and initial migration: passed.
- NestJS production build: passed.
- Generated unit tests: 17/17 passed across 6 suites.
- Generated PostgreSQL integration tests: 20/20 passed across 7 suites.
- Reservation concurrency and tenant-isolation suites: passed.
- Dependency audit: 0 vulnerabilities.

Run the complete repeatable matrix with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-local.ps1
```
