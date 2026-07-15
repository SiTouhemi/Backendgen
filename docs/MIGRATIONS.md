# Database migrations and schema evolution

The compiler owns your migration history. The first generation emits
`prisma/migrations/00000000000000_init/migration.sql` and records a schema
snapshot in `.backendgen/schema-snapshot.json`. Every later generation diffs
the new specification against that snapshot and emits **one new incremental
migration** — `prisma/migrations/00000000000001_backendgen/migration.sql`,
`…02_backendgen`, and so on — leaving every previously emitted migration
byte-for-byte untouched.

## The rule

> A migration that has been applied is immutable. Prisma records a checksum of
> every applied migration; deploying a rewritten file fails, and bypassing the
> check causes silent schema drift.

The generator enforces this for you: once a snapshot exists, history is frozen
and only new migrations are appended.

## The normal loop

```sh
# edit backend.yaml, then:
backendgen generate backend.yaml --output ./my-api
cd my-api
npx prisma migrate deploy    # applies only the new incremental migration
```

`backendgen diff` (or `generate --dry-run`) previews the migration a change
would produce without writing anything.

Migration folder names use a deterministic counter, not a timestamp: Prisma
only requires lexicographic ordering, and a counter keeps generation
byte-identical across machines and reruns.

## Safety classes

Every schema change is classified before any SQL is written:

| Class | Examples | Behaviour |
|---|---|---|
| safe | new table, new nullable column, new index, new enum value | emitted normally |
| needs-default | new **required** column on an existing table | allowed only when the field has a `default` in the specification (used to backfill); otherwise generation fails with `migrate.not-null-requires-default` |
| destructive | drop table/column/enum, column type change, switching a foreign key to `CASCADE` | generation **refuses** with `migrate.destructive-change`; re-run with `--allow-destructive` to emit the statements, each preceded by a `-- DESTRUCTIVE:` comment |

Review anything destructive before deploying. `SET NOT NULL` on an existing
column fails at deploy time if rows still hold NULLs — backfill first.

Enum additions (`ALTER TYPE … ADD VALUE`) are emitted in their own trailing
section: they cannot run inside a transaction block with other DDL on older
PostgreSQL versions.

## Development shortcut

While iterating with a database you do not care about, `npx prisma migrate
reset` re-applies the whole history (and the seed) from scratch. If you would
rather squash accumulated increments during early development, delete the
generated project's `prisma/migrations`, `.backendgen/schema-snapshot.json`
and the database, then regenerate for a fresh `_init`.

## Projects generated before snapshots existed

A project without `.backendgen/schema-snapshot.json` falls back to the old
behaviour once: the initial migration is rewritten in place (with a warning)
and a snapshot is recorded, so every generation after that is incremental. If
the old `_init` was already applied to a database you care about, restore it
from version control (`git checkout -- prisma/migrations/00000000000000_init`)
before deploying, then let the next specification change produce a proper
incremental migration.

## Upgrading a database created by an earlier 0.2 alpha

The 2026-07 hardening release changed database semantics, not only generated
TypeScript. An existing database needs a reviewed incremental migration;
regenerating alone is only sufficient for a brand-new database. Review the
diff for all of the following:

1. **Timezone-aware timestamps.** Generated datetime columns now use
   `TIMESTAMPTZ(3)`. PostgreSQL must be told what timezone legacy `TIMESTAMP`
   values represented. If they were UTC:
   ```sql
   ALTER TABLE "Example"
     ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
     USING "createdAt" AT TIME ZONE 'UTC';
   ```
   Substitute the actual historical timezone if the old application wrote
   local wall-clock values. Guessing here shifts stored instants.
2. **Foreign-key actions.** Earlier output cascaded every required relation.
   Required relations now default to `RESTRICT`; only auth tokens/sessions and
   organization memberships explicitly cascade. Drop and recreate affected
   foreign keys with the action shown in the regenerated schema.
3. **Reservation idempotency.** Drop the old global unique index on
   `idempotencyKey`, add nullable `requestFingerprint`, and create the new
   unique index on `(ownerId, idempotencyKey)` or
   `(organizationId, ownerId, idempotencyKey)`. Existing rows have no
   trustworthy fingerprint; replaying one of their non-null keys intentionally
   returns 409.
4. **Reservation overlap range.** Recreate the exclusion constraint with
   `tstzrange("startsAt", "endsAt", '[)')` after the timestamp conversion.
   Verify `btree_gist` remains installed.
5. **New access-path indexes.** On large production tables, plan lock time and
   consider an operator-authored `CREATE INDEX CONCURRENTLY` rollout.
6. **Notification outbox.** Deploy the `NotificationOutbox` table before
   starting instances that enqueue or dispatch notifications.

Take a backup, rehearse against a production-sized clone, then deploy.

## Feature-owned constraints

Feature packs emit SQL Prisma's schema language cannot express — the
reservations overlap exclusion constraint, for example. These statements are
part of the snapshot: adding or reconfiguring such a feature emits the new
statements in the incremental migration, and removing one emits a commented
note (the generator never guesses how to reverse feature-owned SQL — review
and drop it by hand).
