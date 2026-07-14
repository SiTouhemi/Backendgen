# Customization

`.backendgen/manifest.json` records every compiler-owned and custom-scaffold file. Code under `src/generated/` is regenerated. Code under `src/custom/` is scaffolded once and belongs to the application developer. `CustomModule` is imported last so explicitly provided custom implementations can replace generated defaults.

Use `backendgen diff` before regeneration. If a generated file was edited, generation fails with a stable conflict; move the behavior behind a listed customization contract instead of using `--force`. Untracked user files are preserved unless they collide with a newly generated path.

MCP's `explain_customization_points` tool returns the exact paths, interfaces, and events for a specification without returning file contents.
