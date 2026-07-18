# Token Optimization Benchmark

This benchmark compares two equivalent agent tasks: **A (`direct`)**, write a backend directly; **B (`compiler`)**, write a compact Backend Compiler specification and invoke the compiler. It measures efficiency without assuming either approach wins.

## Paired-run protocol

A comparison is valid only when both arms are true pairs. Hold constant and
record for every run:

- **Model**: the exact provider model version identifier, never a family name.
- **Agent**: the tool name and version (for example a specific CLI release).
- **Prompt**: one committed prompt file per scenario and arm, referenced by
  `protocol.promptFile`; the agent receives nothing else except what
  `protocol.suppliedContext` describes.
- **Requirements**: one shared requirements document per scenario
  (`protocol.requirementsFile`), identical for both arms.
- **Starting state**: a fresh empty directory, or an exact recorded commit hash
  (`protocol.startingRepoState`).
- **Attempts**: the same `protocol.maxAttempts` for both arms; record the
  attempts actually used.
- **Pairing**: assign one `pairId` to exactly one direct run and one compiler
  run. Use a fresh starting state for each run; the pair id records the matched
  trial, not a shared working directory. Record `pairPosition`; alternate which
  arm runs first, or use `independent` only when ordering cannot affect either
  isolated environment.
- **Environment**: same non-sensitive machine label, OS, Node version,
  dependency cache state, tool permissions, and build/test oracle. Record the
  machine and tool fields in `protocol.environment`; never include usernames,
  device serial numbers, or absolute home paths.

Record raw provider token accounting — input, cached-input breakdown, output,
and tool-call breakdown — exactly as reported. When the provider does not report a number, store
`null`; **never infer token counts from lines of code, file sizes, or
expansion measurements**. Record wall-clock time, agent-written files/lines,
compiler-generated files/lines, human corrections, and rewrites of generated
code. Compiler-generated source is never counted as agent output tokens.
For providers where cached-input or tool-call tokens are breakdowns of the
main input/output accounting, the summarizer reports those fields separately
and never adds them a second time. The comparison total is input plus output.

A run **succeeds** only when the build passes, the tests pass, and the shared
functional acceptance checks pass. Failed runs stay in the result set: they are
listed per arm in the summary and count against the success rate; they are only
excluded from token/time medians.

Scenarios are `todo-crud`, `authentication`, `multi-tenant-saas`,
`hotel-booking`, and `appointment-scheduling`. Run each arm at least three
times as at least three complete matched pairs. Store raw results under
`benchmark/runs/` (gitignored). Copy
`result.template.json`, fill only measured values, and run
`npm run benchmark:validate`.

The committed template contains placeholder and `null` measurements and is not
a model result. Never publish synthetic or estimated values as observed
savings.

## Summarizing

After at least three complete direct/compiler pairs exist for the same model,
agent, scenario, and controlled protocol, run `npm run benchmark:summarize`. It:

- validates every result file against `result.schema.json` and refuses invalid
  files;
- refuses incomplete pairs, duplicate run ids, protocol drift, prompt drift,
  attempts beyond the recorded maximum, or fewer than three complete pairs;
- reports correctness (runs, successes, and the ids of failed runs) separately
  from token and time medians;
- reports matched-pair token/time comparisons only when at least three pairs
  succeed in both arms; token evidence additionally requires complete provider
  accounting for every successful pair. Otherwise it exposes no partial median
  or percentage that could be mistaken for a claim.

Both `benchmark:validate` and `benchmark:summarize` accept `--dir <path>` to
point at a different results directory (used by the test suite).

## Deterministic expansion evidence

`npm run benchmark:expansion` measures how many files, lines, and bytes the
compiler deterministically renders from each compact example specification. It
writes `benchmark/expansion.json`; CI can use
`npm run benchmark:expansion:check` to reject stale evidence. Expansion is not
AI token usage and must never be presented as token savings.
