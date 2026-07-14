# Target Adapters

A target implements `TargetAdapter` from `@backend-compiler/target-sdk`: metadata/capabilities, supported databases, commands, IR validation, project rendering, entity rendering, and final composition. Renderers receive only `TargetRenderContext`, never raw YAML/JSON.

Render results contain owned files, ordered root modules/providers/guards, dependencies, scripts, migration DDL, environment declarations, and safe test defaults. Composition rejects different contents at one path and conflicting dependency/script/test-environment values. Identical shared contributions may deduplicate.

Adapter checklist:

1. Declare capabilities and validate database/IR limitations with stable issues.
2. Produce POSIX relative paths and deterministic byte output.
3. Keep generated and custom-scaffold ownership separate.
4. Sort framework composition using explicit order values.
5. Provide reproducible install/build/test/migration commands.
6. Pass feature conformance, generated build, migration, and integration tests.

Only `nestjs-prisma` is supported during the alpha.
