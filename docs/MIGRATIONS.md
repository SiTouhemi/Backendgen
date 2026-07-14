# Database migrations and schema evolution

The compiler emits one initial migration, `prisma/migrations/00000000000000_init/migration.sql`, plus the Prisma schema. Regenerating after a specification change rewrites both **in place**. That is safe exactly as long as the migration has never been applied to a database you care about.

## The rule

> A migration that has been applied is immutable. Prisma records a checksum of every applied migration; deploying a rewritten file fails, and bypassing the check causes silent schema drift.

The generator warns when a regeneration changes an existing migration file. What to do depends on where you are:

## Development (no data worth keeping)

Regenerate, then reset:

```sh
backendgen generate backend.yaml --output ./my-api
cd my-api
npx prisma migrate reset   # drops, re-applies the rewritten init migration, re-seeds
```

This is the intended loop while iterating on a specification.

## Production (an applied migration exists)

Do **not** deploy the rewritten `_init` migration. Create an incremental migration instead:

1. Regenerate into the project as usual. The schema (`prisma/schema.prisma`) now reflects the new specification; the rewritten init migration is the file you must not re-deploy.
2. Restore the applied migration file from version control so history matches the database:
   ```sh
   git checkout -- prisma/migrations/00000000000000_init/migration.sql
   ```
3. Create a separate empty PostgreSQL database for Prisma's shadow database and
   export its URL. Prisma requires this when a migration directory is a diff
   source:
   ```sh
   export SHADOW_DATABASE_URL="postgresql://user:password@localhost:5432/my_api_shadow"
   ```
4. Generate the incremental SQL into a temporary file. Do not create the new
   migration directory until after the diff, or Prisma may interpret the empty
   directory as part of the existing migration history:
   ```sh
   migration_sql="$(mktemp)"
   npx prisma migrate diff \
     --from-migrations prisma/migrations \
     --to-schema-datamodel prisma/schema.prisma \
     --shadow-database-url "$SHADOW_DATABASE_URL" \
     --script \
     --output "$migration_sql"

   migration_dir="prisma/migrations/$(date +%Y%m%d%H%M%S)_update"
   mkdir -p "$migration_dir"
   mv "$migration_sql" "$migration_dir/migration.sql"
   ```
5. Review the SQL — especially drops and type changes — then deploy:
   ```sh
   npx prisma migrate deploy
   ```

The incremental migration file is yours, not the compiler's: it is untracked by the manifest and future regenerations will not touch it. Only the `_init` migration and `schema.prisma` are compiler-owned.

## Upgrading a database created by an earlier 0.2 alpha

This hardening release changes database semantics, not only generated TypeScript. Regenerating is sufficient for a brand-new database. An existing database needs a reviewed incremental migration; leaving the old schema in place can preserve unsafe cascades or globally scoped idempotency even though the new Prisma schema looks correct.

Review the diff for all of the following:

1. **Timezone-aware timestamps.** Generated datetime columns, including `createdAt`, `updatedAt`, soft-delete markers, recovery/session expiry, reservations, and outbox leases, now use `TIMESTAMPTZ(3)`. PostgreSQL must be told what timezone legacy `TIMESTAMP` values represented. If they were UTC, use the equivalent of:
   ```sql
   ALTER TABLE "Example"
     ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
     USING "createdAt" AT TIME ZONE 'UTC';
   ```
   Substitute the actual historical timezone if the old application wrote local wall-clock values. Guessing here shifts stored instants.
2. **Foreign-key actions.** Earlier output cascaded every required relation. Required relations now default to `RESTRICT`; only auth tokens/sessions and organization memberships explicitly cascade. Drop and recreate affected foreign keys with the action shown in the regenerated Prisma schema/migration. This must be done before relying on parent-delete conflict handling.
3. **Reservation idempotency.** Drop the old global unique index on `idempotencyKey`, add nullable `requestFingerprint`, and create the new unique index on `(ownerId, idempotencyKey)` or `(organizationId, ownerId, idempotencyKey)`. Existing rows have no trustworthy fingerprint; replaying one of their non-null keys intentionally returns 409. Keep them for audit/history or expire them according to application policy—do not invent fingerprints from incomplete data.
4. **Reservation overlap range.** Drop the old exclusion constraint before timestamp conversion and recreate it with `tstzrange("startsAt", "endsAt", '[)')`. Verify `btree_gist` remains installed.
5. **New access-path indexes.** Apply the generated foreign-key indexes and tenant ordering index `(organizationId, createdAt, id)`. On large production tables, plan lock time and consider an operator-authored `CREATE INDEX CONCURRENTLY` rollout rather than copying the initial migration verbatim.
6. **Notification outbox.** Enabling durable notification events adds `NotificationOutbox`. Deploy its table/index before starting application instances that enqueue or dispatch notifications.

Take a backup, run the incremental SQL against a production-sized clone, compare constraints with `prisma validate` plus database catalog queries, and only then deploy. The compiler cannot infer the timezone of old values or the retention policy for legacy idempotency keys.

## Feature-owned constraints

Some feature packs emit SQL that Prisma's schema language cannot express — the reservations overlap exclusion constraint (`btree_gist`) lives in the init migration. If your incremental diff touches the reserved resource or interval columns, re-check that the constraint survives; `prisma migrate diff` does not know about it.

## Roadmap

Automatic incremental migration generation (the compiler producing step 3 itself, keyed off the previous schema recorded in the manifest) is planned once the single-migration workflow has design-partner mileage. Until then the guardrail is the warning plus this document.
