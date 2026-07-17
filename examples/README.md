# Examples

Each directory holds one complete `backendcompiler.dev/v1` specification. They mirror the end-to-end scenarios the CI matrix generates, builds and tests against PostgreSQL.

| Example | Features | What it demonstrates |
|---|---|---|
| [notes-api](notes-api/backend.yaml) | crud | The smallest useful backend: public CRUD with pagination, filtering, sorting. |
| [auth-notes](auth-notes/backend.yaml) | crud, auth | Accounts, roles, per-row ownership, and authentication-safe account soft deletion. |
| [saas-tasks](saas-tasks/backend.yaml) | crud, auth, organizations | Multi-tenant isolation enforced server-side. |
| [hotel-booking](hotel-booking/backend.yaml) | crud, auth, reservations, notifications | The reference scenario: holds, database-level overlap prevention, recovery delivery, and a transactional notification outbox. |
| [appointments](appointments/backend.yaml) | crud, auth, reservations | Reservations without holds — immediate confirmation. |
| [desk-booking](desk-booking/backend.yaml) | crud, auth, organizations, reservations, notifications | A compact combined example; where feature interactions show up. |
| [all-features](all-features/backend.yaml) | every feature pack | The canonical input for a clean full-feature generation: crud, auth (verification + reset), organizations, reservations, notifications, webhooks, jobs (cron), and uploads. Regenerating the same freshly generated directory reports no changes. Existing retained proofs preserve their original immutable migrations. |

Try one:

```sh
backendgen validate examples/notes-api/backend.yaml
backendgen generate examples/notes-api/backend.yaml --output ./notes-api
```
