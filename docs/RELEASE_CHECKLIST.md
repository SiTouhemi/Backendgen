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
- [x] A deterministic security contract fuzzes 250 specs in the default suite and 2,000 in a dedicated CI gate, with exact seed replay.
- [x] Public CLI and MCP tarballs install and pass consumer-level smoke tests.
- [x] Generated projects include a bounded frontend contract and strict exact-origin CORS configuration.
- [x] Expansion measurements are reproducible and explicitly separated from token claims.
- [x] npm trusted-publishing and MCP Registry release automation is prepared.
- [x] MCP tool arguments are runtime-validated against the advertised schemas, with adversarial protocol tests.
- [x] Both public contracts (spec and frontend contract) ship as versioned JSON Schemas, exportable via `backendgen export-schema`.
- [x] Tarball file allowlists, version-consistency (`npm run check:release`), and workflow YAML parse checks gate CI; release mode additionally requires `server.json`.
- [ ] Complete an independent generated-code security review.
- [ ] Supply the final public GitHub owner, bootstrap both npm package names, and configure trusted publishing.
- [ ] Complete three real design-partner generations before removing the alpha label.

The local implementation gate is complete. Keep the 0.2.0 label as alpha until
the independent review is complete; public hosting and hosted CI are separate
distribution tasks, not evidence that the generator works.
