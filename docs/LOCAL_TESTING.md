# Local release verification

The complete generated-backend lifecycle can run on Windows without Docker or
GitHub Actions. It needs Node.js 22+, npm, and local PostgreSQL server tools on
`PATH` (`initdb`, `pg_ctl`, `createdb`, and `dropdb`).

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-local.ps1
```

The script creates a disposable trust-authenticated PostgreSQL cluster bound to
`127.0.0.1:55432`. For each of the six scenarios it creates an isolated
database, generates the project, installs its exact direct dependencies, creates
the Prisma client, validates and builds the project, applies the generated
migration, runs unit and PostgreSQL integration tests, and drops the database.
It also runs the compiler unit suite and the high-severity dependency audit.

The cluster and all generated test projects live under the system temporary
directory and are removed in a `finally` block. No existing PostgreSQL cluster
or application database is touched.

To run selected scenarios or use another port:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-local.ps1 `
  -Port 55433 `
  -SkipUnit `
  -Scenarios basic-crud,hotel-reservation,all-features
```
