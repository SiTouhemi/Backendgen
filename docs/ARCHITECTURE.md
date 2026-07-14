# Architecture

The pipeline is deliberately one-way:

```text
YAML/JSON -> schema + semantic validation -> feature resolution -> BackendIR
          -> target validation -> pure render contributions -> composition
          -> generation plan -> filesystem + .backendgen/manifest.json
```

The versioned specification is the public contract. Raw input never reaches a renderer. Feature packs own domain meaning and contribute normalized entities, endpoints, workflows, infrastructure, and target-specific rendering. Target adapters own framework layout, dependencies, database schema, and project composition.

`compileBackend` is pure and returns stable issues or checksummed IR. `renderBackend` merges contributions deterministically, rejects path and dependency conflicts, and sorts output. `generateBackend` compares rendered hashes with the previous manifest before writing. Compiler-owned files may be replaced; custom scaffolds are write-once.

The CLI and MCP server are thin agent interfaces around the same generator runtime. MCP adds allowed-root canonicalization, bounded lists and output, structured errors, and secret-value exclusion.

## Workspace ownership

- `packages/specification`: public schema and loading.
- `packages/compiler`: normalized IR and compilation.
- `packages/feature-sdk`, `features/*`: feature contracts and implementations.
- `packages/target-sdk`, `targets/*`: adapter contracts and NestJS/Prisma renderer.
- `packages/generator-runtime`: registries, rendering, safe writes, manifests, generated tests.
- `apps/cli`, `apps/mcp-server`: agent-facing entry points.
- `packages/testing`, `tests`: conformance and scenario verification.
