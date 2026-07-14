# Token Optimization Benchmark

This benchmark compares two equivalent agent tasks: **A**, write a backend directly; **B**, write a compact Backend Compiler specification and invoke the compiler. It measures efficiency without assuming either approach wins.

## Method

Use the same model/version, system prompt, functional requirements, tool permissions, machine, dependency cache state, and maximum attempts. Run each arm at least three times in a fresh directory. Execute the same build and behavioral test oracle. Record raw provider token accounting, wall time, file counts, human corrections, and rewrites. Do not include compiler-generated source as agent output tokens.

Scenarios are `todo-crud`, `authentication`, `multi-tenant-saas`, `hotel-booking`, and `appointment-scheduling`. Store raw results under `benchmark/runs/` (gitignored). Copy `result.template.json`, fill only measured values, and run `npm run benchmark:validate`.

The committed template contains `null` measurements and is not a model result. Never publish synthetic or estimated values as observed savings.
