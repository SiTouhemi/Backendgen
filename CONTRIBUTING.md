# Contributing

Use Node.js 22. Fork the repository, create a focused branch, and run:

```sh
npm ci
npm test
npm run test:e2e
npm run licenses
```

Changes to validation or IR require stable, path-aware error tests. Renderer changes require deterministic-output and regeneration coverage. Security-sensitive feature changes should include PostgreSQL-backed tests. Do not add a second target or hosted SaaS infrastructure during the 0.2 alpha.

Keep generated customer projects, secrets, `.env`, coverage, benchmark runs, and graph artifacts out of commits. Use named exports and preserve strict TypeScript settings. By contributing, you agree that your contribution is licensed under Apache-2.0.
