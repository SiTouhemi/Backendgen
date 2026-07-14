# Feature Packs

Feature packs declare a name/version, configuration schema, dependencies, conflicts, supported targets, semantic compilation, and renderers. Resolution is deterministic and detects missing dependencies, cycles, conflicts, invalid configuration, missing entities, and unsupported targets.

Built-in packs:

- `crud`: REST CRUD, pagination/filtering/sorting, validation, ownership, soft deletion.
- `auth`: password authentication, JWT access, rotating refresh sessions, roles, reset/verification foundations.
- `organizations`: memberships, organization context, fail-closed tenant filtering.
- `reservations`: holds, lifecycle, idempotency, availability, expiry, PostgreSQL overlap exclusion.
- `notifications`: event-driven log, mock, or Resend provider boundaries and retry behavior.

Features own domain rules; they must not bypass `BackendIR` or write files directly. Add conformance cases, focused semantic tests, deterministic rendering tests, and generated integration tests for every new behavior.
