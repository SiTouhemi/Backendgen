# Security Review Follow-up — 2026-07-18 (second AI adversarial review)

This document updates [SECURITY_REVIEW_2026-07-14.md](SECURITY_REVIEW_2026-07-14.md).
It was produced by a second, independent AI review agent inspecting the working
tree adversarially, including the distribution, MCP, CORS, frontend-contract,
and release-automation work added after 2026-07-14. It is **not** an independent
human security review, and it does not certify generated applications as
production-ready.

## Status of prior evidence

The 2026-07-14 document has two stale statements:

1. **Test counts.** It cites 11 files / 77 tests. The suite has since grown to
   250+ unit/CLI/MCP/compiler/rendering tests plus a 2,000-seed sharded
   security-contract fuzzer with stable seed replay.
2. **"PostgreSQL execution is still unverified locally."** No longer true: a
   disposable local PostgreSQL verifier (`npm run verify:local:postgres`) and
   locally executed integration suites (CRUD, auth, tenant isolation,
   reservation overlap concurrency, `btree_gist` migration) have since passed
   on this workstation, and `docs/LOCAL_VERIFICATION.md` records that run.
   What remains missing is a **public hosted CI** run of the same matrix and
   independent human review.

The prior findings SEC-001 through SEC-011 and their fixes stand unchanged; the
regression tests asserting them still pass.

## New findings from this review (2026-07-18)

| ID | Severity | Finding | Resolution |
|---|---:|---|---|
| SEC-012 | High | The twelve MCP tools advertised JSON Schemas through `tools/list` but never enforced them at runtime. Arguments were force-cast (`rawArgs as unknown as { outputPath: string }`), so nulls, arrays, numbers, unknown properties, and oversized strings reached tool logic and the sandbox, producing uncontrolled `TypeError`s and unstable error text at an untrusted protocol boundary. | Central runtime validation (`apps/mcp-server/src/arguments.ts`) compiles the exact advertised schemas with Ajv and rejects malformed calls before any tool logic or filesystem access, with the stable code `tool.invalid-arguments`, deterministic deduplicated JSON-pointer issues, and no stack traces. Unknown tools return `tool.unknown`. String arguments now carry explicit length bounds. Table-driven adversarial tests exercise every tool through the real MCP transport (`apps/mcp-server/src/arguments.test.ts`). |
| SEC-013 | Medium | `BACKENDGEN_ALLOWED_ROOTS` never split POSIX colon-delimited lists: the Windows drive-letter guard suppressed splitting before `/`, so `/srv/a:/srv/b` stayed one bogus root. Failure mode was fail-closed (startup error), not an escape, but multi-root Linux configuration was unusable and the registry metadata called the format "platform-delimited". | Platform-aware parsing (`parseAllowedRoots`) splits on `:` between POSIX absolute paths while preserving Windows drive letters; documented in `docs/MCP.md` and the MCP Registry environment description; unit tests cover both platforms. |
| SEC-014 | Medium | The public tarballs had no file-allowlist enforcement and the packaged MCP server was smoke-tested only to `tools/list`; a packaging regression could have shipped TypeScript sources, fixtures, or an unbounded/leaky server unnoticed. | `scripts/test-distribution.mjs` now rejects any tarball file outside an exact allowlist, drives a full packaged MCP session (initialize → get_capabilities → validate_spec → preview_generation → generate_backend → get_generation_report), asserts sandbox denials stay `sandbox.denied` without stack traces, asserts invalid arguments fail with `tool.invalid-arguments`, enforces the 64 KB ceiling on every response, and verifies responses do not carry generated source contents. |
| SEC-015 | Medium | Version drift across the root manifest, `GENERATOR_VERSION`, both distribution packages, `action.yml`'s default version, and `server.json` was only partially checked, and only at release time. A stale `action.yml` default would silently execute an old published CLI. | `npm run check:release` (`scripts/check-release-consistency.mjs`) asserts all version sources agree and that `action.yml` and both workflows parse as YAML; CI runs it on every push, and the release workflow runs it with `--release`, which additionally requires `server.json`. |
| SEC-016 | Low | The frontend contract claimed to be a public versioned contract (`backendcompiler.dev/frontend-contract/v1`) without an authoritative machine-readable schema, so consumers could not verify it and structural leaks (new internal fields) had no closed-world check. | Authoritative JSON Schema with `additionalProperties: false` throughout (`packages/specification/schema/frontend-contract.v1.schema.json`); every rendering scenario is validated against it, and tests assert secret environment names never appear in the contract. Both schemas are exportable from the packed CLI via `backendgen export-schema`. |

## Codex verification follow-up

Codex independently reviewed the second-AI changes after the report above and
closed four additional boundary details before accepting the handoff:

- explicit `null` is rejected instead of normalized to omitted arguments;
- `spec` versus `specPath` exclusivity is now part of the advertised JSON
  Schema, and user-controlled issue paths are RFC 6901 escaped;
- sandbox failures, capabilities, and unexpected exceptions no longer disclose
  configured host roots or raw internal exception messages; and
- tarball checks require the README, license, and notice instead of only
  rejecting unexpected files.

Regression coverage was added for each case. The final local rerun passed 27
test files / 298 tests, all 2,000 deterministic fuzz seeds across eight shards,
all ten render/regeneration scenarios, the packed CLI/MCP consumer session,
release consistency, expansion-evidence reproduction, license review, and
`npm audit` with zero reported vulnerabilities. This remains AI-generated local
evidence, not a human security certification or hosted-CI result.

## Reviewed and found sound (no change required)

- **`CORS_ORIGINS` parsing**: exact-origin URL parsing; wildcard, credentials,
  paths, non-HTTP(S) schemes, embedded userinfo, and production HTTP origins
  are rejected; cross-origin credentials stay disabled; output is deduplicated
  and sorted. Generated unit tests cover the rejection matrix.
- **GitHub composite Action**: all inputs flow through environment variables
  into quoted Bash arrays; no GitHub-expression interpolation into shell text,
  so no expression/argument injection was found.
- **Release workflow**: version verification against the release tag before
  publishing, `mcp-publisher` download pinned by SHA-256, `id-token: write`
  scoped OIDC, and a documented first-publish token fallback. Not changed.
  Residual: `actions/checkout@v4`/`actions/setup-node@v4` are tag-pinned, not
  SHA-pinned; exact official commit SHAs were not verifiable offline in this
  session, so the references were deliberately left unchanged.
- **`prepare-mcp-registry.mjs`**: GitHub owner/repository inputs are validated
  against strict patterns before being embedded in URLs or metadata.
- **`run_generated_tests`**: still reachable only through a structurally valid,
  hash-verified generated project (SEC-006 preflight intact).
- **Benchmark tooling**: expansion measurement is deterministic and explicitly
  refuses to present expansion as token savings; the summarizer refuses
  incomplete paired runs. The launch page states that token savings are not
  claimed until controlled paired runs exist.
- **Agent Skill**: instructs agents to treat `--force`, `--allow-destructive`,
  and `--accept-manual` as explicit human decisions.

## Evidence classes (kept distinct)

1. **Prior findings (2026-07-14)**: fixed; regression-tested.
2. **Locally rerun evidence (2026-07-17/18)**: build, full unit/CLI/MCP suites,
   2,000-seed fuzz contract, scenario render/regeneration suites, packed
   CLI/MCP consumer smoke tests, expansion reproducibility, `npm audit` clean,
   and a local PostgreSQL verifier run. Recorded in `docs/LOCAL_VERIFICATION.md`
   and the repository test suites.
3. **Second-AI adversarial review (2026-07-18, this document)**: SEC-012–016
   found and fixed with regression tests. An AI review is a useful additional
   filter, not a substitute for a human one.
4. **Public hosted CI evidence**: **not yet observed.** No public CI run of the
   PostgreSQL matrix exists yet.
5. **Independent human security review**: **still pending.** Required before
   removing the alpha label; see `docs/RELEASE_CHECKLIST.md`.

## Release decision

Unchanged in kind from 2026-07-14, with a stronger local evidence base: the
compiler is suitable for continued alpha use, design-partner trials, and public
source review. Do not describe generated applications as production-ready, and
do not treat this AI review as an independent security certification.
