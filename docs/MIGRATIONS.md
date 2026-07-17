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

## Manual migrations and `--accept-manual`

Some transitions cannot be generated safely and fail closed until a person
writes the SQL:

| Refusal | Meaning |
|---|---|
| `migrate.not-null-backfill-required` | making an existing column required needs a data backfill before `SET NOT NULL` |
| `migrate.not-null-requires-default` | a new required column has no default to backfill existing rows with (fixable in the specification, or manually) |
| `migrate.feature-sql-change-unsupported` | feature-owned raw SQL was removed or replaced |
| `migrate.enum-change-unsupported` | an enum was removed, reordered, or changed anywhere except its tail |

The completion workflow records a reviewed, hand-written migration as
implementing the whole pending transition, then advances the snapshot so
regeneration stops refusing:

```sh
# 1. Change backend.yaml (say Note.pinned goes from optional to required).
#    Generation now refuses with migrate.not-null-backfill-required.
backendgen generate backend.yaml --output ./my-api

# 2. Write the migration by hand, in a new timestamped directory that sorts
#    after every existing migration:
mkdir -p my-api/prisma/migrations/20260717120000_backfill_pinned
cat > my-api/prisma/migrations/20260717120000_backfill_pinned/migration.sql <<'SQL'
UPDATE "Note" SET "pinned" = false WHERE "pinned" IS NULL;
ALTER TABLE "Note" ALTER COLUMN "pinned" SET NOT NULL;
SQL

# 3. Apply it (development: prisma migrate deploy; production: your normal
#    reviewed rollout).
cd my-api && npx prisma migrate deploy && cd ..

# 4. Tell the generator that this migration implements the pending transition:
backendgen generate backend.yaml --output ./my-api \
  --accept-manual 20260717120000_backfill_pinned
```

Acceptance validates before it trusts: the directory must exist with a
non-empty `migration.sql`, must not be generator-owned (`*_backendgen`) or
already recorded, must sort after all recorded history, and must mention every
table, column, and enum the pending diff touches (`migrate.accept-incomplete`
lists anything missing). Only then does the snapshot advance — no automatic
migration is emitted, the migration's SHA-256 is recorded in the manifest and
in `.backendgen/accepted-migrations.json` together with the snapshot hashes it
bridges.

From that point the accepted file is immutable history: editing it fails
`migrate.history-modified`, deleting it fails `migrate.history-missing`, and
tampering with the acceptance record fails
`migrate.accepted-record-modified` — all fail closed even with `--force`.
Restore such files from version control. `backendgen diff --accept-manual …`
previews an acceptance without writing anything.

`--accept-manual` is deliberately narrow. It never bypasses validation of
history, and it is not an "ignore migration safety" switch: it always names one
reviewed migration and one pending transition.

In production, run step 3 with your normal migration rollout (backup, rehearse
on a clone, deploy) **before** accepting: acceptance asserts that the database
transition has been handled.

## Recovery after an interrupted generation

Generation writes the manifest last. If a run is interrupted after files were
written but before the manifest, the next run fails closed (typically
`migrate.snapshot-modified` or `generate.untracked-file`) instead of guessing.
Restore the generated project's `.backendgen/` directory and
`prisma/migrations/` from version control (`git checkout -- .backendgen prisma/migrations`)
and regenerate. Committing every generated project after each successful
generation is what makes this recovery trivial.

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
