# Feature Packs

Feature packs declare a name/version, configuration schema, dependencies, conflicts, supported targets, semantic compilation, and renderers. Resolution is deterministic and detects missing dependencies, cycles, conflicts, invalid configuration, missing entities, and unsupported targets.

`backendgen describe-feature <name>` prints the live configuration schema and examples for any pack; the tables below summarize each one.

## crud

REST CRUD endpoints per entity: paginated list with filtering and sorting, get, create, update, delete. All request validation is server-side; pagination is bounded; soft-deleted and out-of-scope rows are filtered in the database query, never in application code.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `entities` | string[] | every spec entity | Entities to expose. |
| `softDelete` | string[] | `[]` | Delete sets `deletedAt` instead of removing the row. |
| `ownedBy` | object | `{}` | Entity → owner-entity map. Rows readable/writable only by their owner or an admin role. Requires `auth`. |
| `adminRoles` | string[] | `["admin"]` | Roles that bypass ownership scoping. |
| `destructiveRoles` | string[] | `adminRoles` | Account roles allowed to delete non-tenant entities that are not row-owned. Must be declared by `auth`. |
| `destructiveOrgRoles` | string[] | all organization roles except the least privileged | Organization roles allowed to delete tenant-scoped entities. Must be declared by `organizations`. |
| `defaultPageSize` | integer | 20 | 1–200. Must not exceed `maxPageSize`. |
| `maxPageSize` | integer | 100 | 1–500. |

`ownedBy` currently maps only to `auth.userEntity`: generated services write the authenticated user ID into the owner foreign key. A different owner entity is rejected at compile time instead of producing a backend that fails every write.

```yaml
features:
  crud:
    softDelete: [Note]
    ownedBy: { Note: User }
```

## auth

Email/password authentication: bcrypt hashing (cost 12, 72-byte ceiling), JWT access tokens (HS256 allowlist), opaque rotating refresh sessions with reuse detection and family revocation, login throttling, optional email verification and password reset with single-use atomically-consumed tokens. Creates `RefreshSession` (and token entities when enabled); extends the user entity with `email`, `passwordHash`, `role`, `emailVerifiedAt` and removes it from the generic CRUD surface.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `userEntity` | string | `"User"` | Entity that stores accounts. |
| `methods` | string[] | `["email_password"]` | Only `email_password` today. |
| `roles` | string[] | `["admin", "user"]` | Most privileged first. |
| `defaultRole` | string | last role | Role granted on self-registration. Must be a declared role. |
| `accessTokenTtlSeconds` | integer | 900 | 60–3600. |
| `refreshTokenTtlDays` | integer | 30 | 1–365. |
| `emailVerification` | boolean | `true` | Generates verification endpoints and token entity. |
| `passwordReset` | boolean | `true` | Generates reset endpoints and token entity. |
| `minPasswordLength` | integer | 12 | 8–72 (bcrypt's safe ceiling). |
| `rateLimit` | object | `{ ttlSeconds: 60, limit: 10 }` | Process-local login throttle. Use a shared store behind a load balancer. |

Secrets: `JWT_ACCESS_SECRET` (min 32 chars) is required at boot; there is no default and no fallback. Enabling either recovery flow also requires the `notifications` feature with a delivering `resend` or `custom` provider. The metadata-only `log` provider is deliberately rejected for recovery because it discards links. If the auth entity is soft-deletable, login, JWT validation, refresh, account recovery, and `/auth/me` all require `deletedAt: null`; refresh sessions are revoked when a deleted account attempts rotation.

## organizations

Multi-tenancy: `Organization` and `Membership` entities, organization context resolution per request, role guard, member management with a last-owner invariant enforced in serializable transactions. Scoped entities gain an `organizationId` foreign key, and every generated query filters on it server-side (fail-closed: no organization context means no rows).

| Option | Type | Default | Meaning |
|---|---|---|---|
| `scopedEntities` | string[] | every entity except the user entity | Entities isolated per organization. |
| `roles` | string[] | `["owner", "admin", "member"]` | Most privileged first; first role granted to the creator. |
| `defaultRole` | string | — | Role for invited members. Must be declared. |
| `userEntity` | string | `"User"` | Never organization-scoped: one account can join many tenants. |

Depends on `auth`.

## reservations

Time-interval booking of a resource: hold → confirm → cancel lifecycle (or immediate confirmation when holds are disabled), idempotency keys with owner/tenant-scoped replay and request fingerprints, resource-scoped availability queries, draining batched hold expiry, and — on PostgreSQL — a `btree_gist` exclusion constraint over `tstzrange` so overlapping reservations are impossible at the database level, not just the application level.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `resource` | string | required | Entity being reserved (e.g. `Room`). |
| `owner` | string | required | Entity holding the reservation (normally the user entity). |
| `entity` | string | `"Reservation"` | Name of the entity this feature creates. Must not already exist. |
| `preventOverlap` | boolean | `true` | PostgreSQL exclusion constraint. Requires `database: postgresql`. |
| `holdMinutes` | integer | 15 | 0–1440. 0 disables holds and confirms immediately. |
| `minDurationMinutes` | integer | 1 | Must not exceed `maxDurationMinutes`. |
| `maxDurationMinutes` | integer | 43200 | |
| `cancellationWindowMinutes` | integer | 0 | Minutes before start after which cancellation is refused. |

Depends on `auth`, and `owner` must equal `auth.userEntity` until custom principal mapping is implemented. A repeated idempotency key returns the original reservation only when the canonical resource/start/end fingerprint matches; a changed payload returns 409. `holdMinutes: 0` removes the confirm endpoint, expiry job, and HELD/EXPIRED workflow states. Emits `reservation.created`, `reservation.confirmed`, and `reservation.cancelled`; hold-enabled configurations also emit `reservation.expired`.

## notifications

Event-driven outbound messages behind a provider interface. Non-secret events use a transactional PostgreSQL outbox: domain state and enqueue commit together, workers claim rows with `FOR UPDATE SKIP LOCKED`, provider calls use leases, and retry/backoff state is persisted. Delivery is at least once, so custom providers should use their own idempotency support. Recovery credentials are the deliberate exception: raw tokens are never persisted and are delivered inline with bounded retries.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `log` \| `resend` \| `custom` | `"log"` | Overridable at runtime with `NOTIFICATIONS_PROVIDER`. `log` is a non-delivering metadata sink; `custom` requires `CUSTOM_NOTIFICATION_PROVIDER` from `CustomModule`. `mock` is test-only. |
| `from` | string | `"no-reply@example.com"` | Overridable with `NOTIFICATIONS_FROM`. |
| `events` | string[] | `[]` | `user_registered`, `user_email_verification_requested`, `user_password_reset_requested`, `reservation_created`, `reservation_confirmed`, `reservation_cancelled`, `reservation_expired`. Reservation events require the `reservations` feature. |
| `maxAttempts` | integer | 3 | 1–10. Recovery retries inline; outbox retry state is persisted and terminal rows have sensitive payloads cleared. |

When auth enables verification or reset, those events are added automatically and `APP_PUBLIC_URL` is required. It must be an HTTP(S) origin without credentials/path/query/fragment, and production requires HTTPS. Durable event payloads contain only record identifiers; recipient addresses are resolved at dispatch time and soft-deleted accounts are excluded.

## Writing a new pack

Features own domain rules; they must not bypass `BackendIR` or write files directly. A pack contributes entities and patches during compilation, endpoints and workflows to the IR, and pure render functions per target. Add conformance cases, focused semantic tests, deterministic rendering tests, and generated integration tests for every new behavior. See `packages/feature-sdk` for the contracts and any built-in pack for a template.

## jobs

Durable background jobs on PostgreSQL — no Redis or external queue. Creates
the internal `JobRecord` entity. Enqueue transactionally with
`JobService.enqueue(tx, name, payload, { runAt?, dedupeKey? })`; register
handlers from `src/custom/jobs.ts` by providing `CUSTOM_JOB_HANDLERS` in
`CustomModule`. Execution is leased (`FOR UPDATE SKIP LOCKED`), multi-instance
safe, and at-least-once: handlers should be idempotent. Failures retry with
persisted exponential backoff; throw `NonRetryableJobError` to fail
immediately. Payloads are cleared in terminal states; DONE rows are deleted
after `retentionDays`.

The claim lease is fixed at two minutes and is **not renewed** while a handler
runs. A handler that runs longer than the lease can be claimed again by
another instance and executed concurrently — keep handlers short (well under
two minutes) or make them explicitly safe under concurrent duplicate
execution; the attempt counter is consumed at claim time either way.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxAttempts` | integer 1-10 | 5 | attempts before FAILED |
| `pollIntervalMs` | integer 1000-60000 | 5000 | per-instance poll interval |
| `retentionDays` | integer 1-365 | 7 | how long DONE rows are kept |
| `cron` | `[{ name, schedule }]` | `[]` | five-field UTC cron; exactly one run per occurrence via dedupe keys |

```yaml
features:
  jobs:
    cron:
      - name: nightly-cleanup
        schedule: "0 3 * * *"
```

## uploads

Presigned direct-to-storage uploads for S3-compatible stores with **no SDK
dependency** — SigV4 presigning is generated code, verified against the AWS
documentation known-answer vector and exercised end-to-end against MinIO.
Size and content-type limits are part of the signature, so the store itself
rejects a non-conforming upload; `complete` additionally verifies the stored
object server-side before anything becomes downloadable. Object keys are
always server-chosen. Attachments inherit the parent entity''s
tenant/ownership scoping; stale unfinished uploads are swept with their
objects.

Compatibility requirements for the store: SigV4 presigned URLs and the
`If-None-Match: *` conditional header on PUT (it keeps completed objects
immutable while their upload URL is still valid). AWS S3 documents both;
MinIO is what the generated integration flow is actually tested against.
Verify other S3-compatible providers before relying on them. Credentials are
static keys only — session tokens, instance metadata, and workload identity
are not implemented. The `mock` provider is refused outside `NODE_ENV=test`.

Local development needs no external account: the generated
`docker-compose.yml` runs MinIO with a health check and a one-shot bucket
bootstrap, and `.env.example` ships matching `S3_*` defaults, so
`docker compose up -d postgres minio minio-init` gives a working uploads
stack.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `entities` | map entity → `{ maxSizeMb, allowedTypes }` | required | which entities accept attachments |
| `presignTtlMinutes` | integer 1-60 | 15 | presigned URL lifetime |
| `staleAfterMinutes` | integer 5-1440 | 60 | when unfinished uploads are swept |

Flow: `POST /<parents>/:id/attachments` (declare fileName/contentType/size)
→ PUT the bytes to the returned URL with the returned headers →
`POST /<parent>-attachments/:id/complete` → `GET /<parent>-attachments/:id`
for a download link. Env: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY` (+ optional `S3_REGION`, `S3_FORCE_PATH_STYLE`).

```yaml
features:
  uploads:
    entities:
      Note: { maxSizeMb: 5, allowedTypes: [image/png, image/jpeg] }
```
