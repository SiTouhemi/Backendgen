# Landing-page facts

This note records the repository evidence behind the launch-page copy. It is a
copy checklist, not a second product specification.

## Commands and output

- Starter command: `npx @2hemi/backendgen init backend.yaml` (the public-package form
  of `backendgen init [path]`, defined in `apps/cli/src/index.ts` and documented
  in `README.md`). The package is not described as available before the first
  public release.
- Generated projects contain `src/`, `prisma/`, `client/`, `test/`, and
  `frontend-contract.json`. These paths come from the NestJS/Prisma target and
  feature renderers; scenario tests also require and validate the frontend
  contract.
- The page's short pipeline labels are `VALIDATE -> NORMALIZE -> GENERATE`.
  They summarize the one-way pipeline documented in `docs/ARCHITECTURE.md`:
  validation, feature resolution into normalized `BackendIR`, deterministic
  rendering, and safe filesystem generation.

## Measured numbers

- **2,000 seeded specs**: the complete deterministic fuzz gate, documented in
  `README.md` and `docs/FUZZ_SECURITY_CONTRACT.md`.
- **10 scenarios**: `packages/testing/src/scenarios.ts`; the same ten-project
  lifecycle is documented in `docs/LOCAL_TESTING.md`.
- **26-73 spec lines -> 54-107 generated files**: the five checked-in local
  measurements in `benchmark/expansion.json`, reproducible with
  `npm run benchmark:expansion:check`.
- **12 MCP tools**: the twelve entries in
  `apps/mcp-server/src/definitions.ts`.

The expansion measurement is deterministic representation expansion, not an
AI-token benchmark. The page must not claim token savings until controlled,
paired model runs exist.

## Agent workflow and integration boundaries

- The agent writes or updates the versioned specification, BackendGen compiles
  the generated repository, and the agent consumes `frontend-contract.json`
  and the generated client to connect the frontend. This responsibility split
  is documented in `README.md`, `docs/ARCHITECTURE.md`,
  `docs/AI_BUILDERS.md`, and the bundled Agent Skill.
- The local MCP package is supported for stdio-capable clients such as Codex,
  Claude Code, and Cursor-style clients.
- Lovable and v0 browser projects use the documented GitHub/local handoff in
  the current alpha. The page does not describe the stdio package as a direct
  remote MCP integration.
- Guided design-partner trials are free during alpha and make no
  production-readiness or token-savings promise, as required by
  `docs/DESIGN_PARTNERS.md`.
