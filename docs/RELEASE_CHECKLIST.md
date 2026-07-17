# Local Alpha Release Checklist

- [x] Clean workspace install is lock-file based.
- [x] TypeScript build and unit suites pass.
- [x] CLI subprocess and MCP protocol contracts are tested.
- [x] Ten scenarios generate and regenerate deterministically with custom files preserved.
- [x] All ten generated applications install, Prisma-validate, build, and pass unit tests on Windows.
- [x] A disposable local PostgreSQL verifier executes every scenario without Docker.
- [x] License inventory, benchmark foundation, and OSS/security documents exist.
- [x] PostgreSQL CRUD, auth, tenant, reservation, and notification suites pass locally.
- [x] The hotel `btree_gist` migration and overlap-concurrency test pass locally.
- [x] A fresh 15-entity, eight-feature backend installs, builds, migrates, and passes 109 generated unit/integration tests.
- [ ] Complete an independent generated-code security review.

The local implementation gate is complete. Keep the 0.2.0 label as alpha until
the independent review is complete; public hosting and hosted CI are separate
distribution tasks, not evidence that the generator works.
