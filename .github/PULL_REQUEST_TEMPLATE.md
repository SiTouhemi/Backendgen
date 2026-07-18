<!-- Never include secrets, .env contents, generated customer repositories, or private specifications. -->

## What and why

<!-- The change and the problem it solves. Link the issue if one exists. -->

## Checks

- [ ] `npm ci && npm test` passes locally
- [ ] Renderer or generation changes: `npm run test:e2e` passes and output stays deterministic
- [ ] Validation/IR changes include stable, path-aware error tests
- [ ] No generated customer projects, benchmark runs, or `.env` files committed

See `CONTRIBUTING.md` in the repository root. Contributions are licensed under Apache-2.0.
