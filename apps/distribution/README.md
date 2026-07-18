# BackendGen

BackendGen is a deterministic backend compiler for AI coding agents. An agent
writes a compact `backendcompiler.dev/v1` YAML or JSON specification; BackendGen
validates it and generates a tested NestJS, Prisma, and PostgreSQL repository
plus a typed TypeScript client.

## CLI

```sh
npx backendgen init backend.yaml --name my-api
npx backendgen validate backend.yaml
npx backendgen generate backend.yaml --output ./backend
```

Preview regeneration before writing:

```sh
npx backendgen diff backend.yaml --output ./backend
```

For agent integration, install the companion `backendgen-mcp` package.

BackendGen is licensed under Apache-2.0. Generated projects belong to their
users and have no BackendGen runtime dependency.
