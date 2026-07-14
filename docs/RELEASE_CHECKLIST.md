# Alpha Release Checklist

- [x] Clean workspace install is lock-file based.
- [x] TypeScript build and unit suites pass.
- [x] CLI subprocess and MCP protocol contracts are tested.
- [x] Six scenarios generate and regenerate deterministically with custom files preserved.
- [x] A generated CRUD application installs, Prisma-validates, builds, and passes unit tests on Windows.
- [x] CI defines PostgreSQL-backed execution for every scenario.
- [x] License inventory, benchmark foundation, and OSS/security documents exist.
- [ ] Observe a green public GitHub Actions run.
- [ ] Confirm PostgreSQL CRUD/auth/tenant/reservation suites in that run.
- [ ] Confirm the hotel `btree_gist` migration and overlap-concurrency test in that run.
- [ ] Complete an independent generated-code security review.

Do not call 0.2.0 release-ready until every unchecked item has evidence linked from the release notes.
