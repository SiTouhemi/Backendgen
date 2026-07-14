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

## Feature-owned constraints

Some feature packs emit SQL that Prisma's schema language cannot express — the reservations overlap exclusion constraint (`btree_gist`) lives in the init migration. If your incremental diff touches the reserved resource or interval columns, re-check that the constraint survives; `prisma migrate diff` does not know about it.

## Roadmap

Automatic incremental migration generation (the compiler producing step 3 itself, keyed off the previous schema recorded in the manifest) is planned once the single-migration workflow has design-partner mileage. Until then the guardrail is the warning plus this document.
