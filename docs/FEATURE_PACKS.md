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
| `defaultPageSize` | integer | 20 | 1–200. Must not exceed `maxPageSize`. |
| `maxPageSize` | integer | 100 | 1–500. |

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

Secrets: `JWT_ACCESS_SECRET` (min 32 chars) is required at boot; there is no default and no fallback.

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

Time-interval booking of a resource: hold → confirm → cancel lifecycle (or immediate confirmation when holds are disabled), idempotency keys with owner/tenant-scoped replay, availability queries, batched hold expiry, and — on PostgreSQL — a `btree_gist` exclusion constraint so overlapping reservations are impossible at the database level, not just the application level.

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

Depends on `auth`. Emits `reservation.created` / `confirmed` / `cancelled` / `expired` events.

## notifications

Event-driven outbound messages behind a provider interface. Providers: `log` (metadata-only, never logs recipients or bodies) and `resend` (HTTP with a 10-second timeout; permanent 4xx failures are not retried). The reservation and auth services never know how a message is delivered — they emit domain events.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `log` \| `resend` | `"log"` | Overridable at runtime with `NOTIFICATIONS_PROVIDER`. |
| `from` | string | `"no-reply@example.com"` | Overridable with `NOTIFICATIONS_FROM`. |
| `events` | string[] | `[]` | `user_registered`, `user_email_verification_requested`, `user_password_reset_requested`, `reservation_created`, `reservation_confirmed`, `reservation_cancelled`, `reservation_expired`. Reservation events require the `reservations` feature. |
| `maxAttempts` | integer | 3 | 1–10 delivery attempts before the failure is logged and dropped. |

## Writing a new pack

Features own domain rules; they must not bypass `BackendIR` or write files directly. A pack contributes entities and patches during compilation, endpoints and workflows to the IR, and pure render functions per target. Add conformance cases, focused semantic tests, deterministic rendering tests, and generated integration tests for every new behavior. See `packages/feature-sdk` for the contracts and any built-in pack for a template.
