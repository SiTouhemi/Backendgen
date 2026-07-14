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
| Arbitrary code execution through `run_generated_tests` | Validated generation manifest, safe canonical paths, and hash verification of every compiler-owned file before any package command runs | Allowed roots and editable custom code are trusted operator-controlled code-execution boundaries. |
| Context/log flooding | 64 KB MCP response ceiling, bounded path lists and failing-log slice | Treat tool output as untrusted data. |
| Tenant data leakage | Generated server-side scoping, fail-closed guards, scoped writes, and tenant validation on related rows | Run PostgreSQL integration tests and review custom providers. |
| Deleted-account reuse | Every auth lookup filters soft-deleted users; refresh attempts revoke the remaining session family | Custom identity integrations must preserve the same active-account predicate. |
| Reservation race or idempotency leakage | PostgreSQL `btree_gist`, atomic conditional state changes, and owner/tenant-scoped idempotency replay | Deploy migrations; do not replace the constraint with app-only checks. |
| Credential or token disclosure in logs | Query-free error paths and metadata-only notification logging | Review logging added by custom code and downstream infrastructure. |
| Lost or duplicated notifications | Domain writes enqueue in the same transaction; leased `SKIP LOCKED` dispatch persists retries and clears terminal payloads | Delivery is at least once; custom providers should use provider-side idempotency. Recovery tokens deliberately remain inline/non-durable and may require a fresh request after a crash. |
| Supply-chain compromise | Lock file, high-severity audit in CI, deterministic license inventory | Review updates and pin CI actions by policy. |

Generated code is a starting point, not a security certification. Deployment authentication, TLS, rate limits, observability, backups, and incident response stay with the operator.
