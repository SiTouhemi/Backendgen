# Generated security contract

Backend Compiler treats generated-code security properties as an executable
contract, not a release-note claim. `tests/fuzz-invariants.test.ts` assembles
valid specifications from deterministic seeds, compiles and renders each one,
then checks the generated repository without installing dependencies or
starting a database.

## What every seed proves

Each generated backend must satisfy these invariant families:

1. Every rendered path is a safe relative path inside the output root.
2. Response-shaped DTOs never contain password or session-token hashes.
3. Authentication installs the global JWT guard, making routes deny by default.
4. CRUD services enforce configured tenant and owner scope.
5. Soft-deleted users cannot count as active organization owners or be added as members.
6. Reservation idempotency replay and unique-race recovery use owner/tenant scope,
   reject a changed request fingerprint, and keep internal keys out of responses.
7. Webhook delivery requires HTTPS outside explicit local/test loopback, rejects
   credentials and every non-public DNS answer, pins the resolved address at
   delivery, isolates tenant fan-out, and never lists signing secrets.
8. Uploads inherit parent tenant/owner/soft-delete scope, use server-generated
   object keys, sign size/type/conditional-write headers, and refuse the mock
   provider outside tests.
9. Notification logs are metadata-only, soft-deleted recipients are excluded,
   raw provider errors are not persisted, terminal rows clear their payload,
   and recovery credentials never enter the durable outbox.
10. Compiling the same specification succeeds and rendering it twice is byte-identical.

The corpus varies authentication, organizations, ownership, soft deletion,
reservations with and without holds, notifications and providers, webhooks,
uploads, jobs, API options, scalar field families, indexes, and required or
optional relations with referential actions.

## Gates and deterministic replay

The normal test suite checks 250 seeds on every supported CI operating system.
A dedicated Linux CI job checks 2,000 distinct seeds, split into eight isolated
250-seed processes so a long property run cannot overflow the test runner's
worker message channel:

```sh
npm run test:fuzz
npm run test:fuzz:ci
```

On PowerShell:

```powershell
npm run test:fuzz:ci
```

For a custom contiguous range, set `BACKENDGEN_FUZZ_START_SEED` and
`BACKENDGEN_FUZZ_SAMPLES` before `npm run test:fuzz`.

Every failure includes its seed and selected feature facts. Replay exactly one
counterexample with:

```sh
BACKENDGEN_FUZZ_SEED=417 npm run test:fuzz
```

```powershell
$env:BACKENDGEN_FUZZ_SEED = "417"
npm run test:fuzz
```

Seed and sample values are validated and bounded. No random clock, network,
database, or dependency installation participates in the property test.

## What this proof does not claim

This is a render-time structural contract. It does not replace the generated
Jest suites, PostgreSQL concurrency and tenant-isolation matrix, live HTTP smoke
tests, dependency audit, or an independent security review. Those gates cover
runtime behavior that string/structure invariants cannot prove. The CI result,
test source, and printed counterexample are the evidence; do not publish a
cumulative pass count disconnected from a specific commit.
