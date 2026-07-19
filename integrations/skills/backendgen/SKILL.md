---
name: backendgen
description: Generate, validate, regenerate, and test deterministic NestJS, Prisma, and PostgreSQL backends from compact backendcompiler.dev/v1 YAML or JSON specifications. Use when an AI-built frontend needs a backend, when creating CRUD/auth/organizations/reservations/notifications/webhooks/jobs/uploads features, when changing an existing BackendGen project, or when minimizing agent-written backend code and context usage.
---

# BackendGen

Use BackendGen as the source-code engine. Write or edit the compact specification; do not manually recreate files the compiler owns.

## MCP workflow

1. Call `get_capabilities` first.
2. Call `describe_target` once for `nestjs-prisma` and `describe_feature` only for relevant features.
3. Create or update a `backendcompiler.dev/v1` specification. Do not invent security, ownership, tenant, or deletion defaults.
4. Call `validate_spec`; fix every stable code/path issue before continuing.
5. Call `inspect_spec` when endpoint, permission, event, secret, or infrastructure semantics need review.
6. Call `preview_generation` before changing an existing generated project.
7. Call `generate_backend`. Never set `force` merely to hide a conflict; move custom behavior behind a reported customization point.
8. Call `run_generated_tests`. Request integration tests when PostgreSQL is reachable.
9. Use `get_generation_report` and `explain_customization_points` for handoff. Do not request generated source dumps.

## CLI fallback

When MCP is unavailable, use:

```sh
npx @2hemi/backendgen validate backend.yaml
npx @2hemi/backendgen diff backend.yaml --output ./backend
npx @2hemi/backendgen generate backend.yaml --output ./backend
npx @2hemi/backendgen test-generated --output ./backend --install
```

Add `--integration` only with a deliberate `DATABASE_URL`. Treat destructive or manual migrations as review gates; never pass `--allow-destructive`, `--accept-manual`, or `--force` without an explicit user decision.

## Frontend handoff

Read `frontend-contract.json` instead of scanning backend source. Use the generated zero-dependency client under `client/`; configure its base URL, bearer token callback, and organization context. Set `CORS_ORIGINS` to comma-separated exact frontend origins. Production origins must use HTTPS.

## Ownership rules

- Treat `src/generated/` and manifest-owned files as compiler-owned.
- Put application behavior in `src/custom/` through generated interfaces and injection tokens.
- Preserve the versioned specification as the public contract.
- Report the specification path, output path, feature list, generation summary, tests, and remaining human decisions concisely.
