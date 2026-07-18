<!-- TEMPLATE ONLY. Copy per scenario and arm, commit the copy you actually used, and reference it from protocol.promptFile. Not an observed benchmark artifact. -->

# Paired benchmark prompt — <scenario> / <direct|compiler> arm

You are building a backend API. The functional requirements are in the attached
requirements document and nothing else. Work in the current empty directory.

- Direct arm: implement the backend yourself with NestJS, Prisma, and
  PostgreSQL. Do not use Backend Compiler.
- Compiler arm: write a `backendcompiler.dev/v1` specification and generate the
  backend with the `backendgen` CLI or MCP server. Do not hand-write generated
  files.

Stop when `npm run build` and the project tests pass, or after the agreed
maximum number of attempts.
