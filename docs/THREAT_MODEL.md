# Threat Model

## Assets and trust boundaries

Assets include the host filesystem, source specifications, generated repositories, environment secrets, and database data. Specifications and MCP arguments are untrusted. Feature packs and target adapters installed in this monorepo execute with the compiler process's authority and are trusted code. Configured MCP allowed roots are an operator decision.

## Principal threats and controls

| Threat | Control | Residual responsibility |
|---|---|---|
| Path traversal or sibling-prefix escape | Canonical allowed-root checks | Configure narrow roots. |
| Symlink/junction escape | Resolve the closest existing ancestor through `realpath` | Protect roots from concurrent hostile mutation. |
| Overwriting user code | Manifest hashes, ownership classes, refusal by default | Review `--force` use. |
| Secret disclosure to agents | MCP returns secret names only; test runner uses a minimal environment | Do not put secret values in specs or generated files. |
| Context/log flooding | 64 KB MCP response ceiling, bounded path lists and failing-log slice | Treat tool output as untrusted data. |
| Tenant data leakage | Generated server-side scoping and fail-closed guards | Run PostgreSQL integration tests and review custom providers. |
| Reservation race | PostgreSQL `btree_gist` exclusion constraint | Deploy migrations; do not replace the constraint with app-only checks. |
| Supply-chain compromise | Lock file, high-severity audit in CI, deterministic license inventory | Review updates and pin CI actions by policy. |

Generated code is a starting point, not a security certification. Deployment authentication, TLS, rate limits, observability, backups, and incident response stay with the operator.
