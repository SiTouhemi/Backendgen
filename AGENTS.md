# Project: Backend Compiler

## Mission

Build a deterministic backend feature compiler for coding agents. Agents submit a compact, versioned specification; the compiler validates it, creates a normalized intermediate representation, and eventually generates tested backend repositories.

## Current scope

- TypeScript 5 and Node.js 22.
- npm workspaces.
- NestJS + Prisma + PostgreSQL is the first future target.
- FastAPI is explicitly out of scope until the first target and feature conformance tests are stable.
- The compiler must work locally without a SaaS account.

## Commands

- Install: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Validate example: `npm run validate:example`
- Inspect example IR: `npm run inspect:example`

## Architecture rules

- The versioned specification is the public contract.
- YAML/JSON input must never be passed directly to target templates.
- All generators consume the normalized `BackendIR`.
- Validation errors must include a stable code and a useful path.
- Agent-facing output should be concise and structured; never return generated file contents by default.
- Features own domain semantics; targets own framework-specific rendering.
- Generated and custom application code must remain separable.

## Code conventions

- Use named exports.
- Keep modules focused and colocate tests with source.
- Prefer immutable data and pure compilation steps.
- Do not silently invent defaults that change security or data ownership.
- Add tests for every validation rule and IR transformation.

## Boundaries

- Never commit secrets or generated customer projects.
- Do not add a second target before the first target passes conformance tests.
- Do not add SaaS infrastructure before local design-partner validation.
- Run build and tests before considering a change complete.
