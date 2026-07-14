# Specification

`backendcompiler.dev/v1` is the stable public input contract. A document contains `specVersion`, project metadata, one target/database pair, application entities, and feature configuration. See `packages/specification/schema/backend-spec.v1.schema.json` for the authoritative JSON Schema and `examples/hotel-booking/backend.yaml` for a complete example.

Validation has two stages: structural JSON Schema validation and semantic compilation. Errors contain a stable `code`, JSON-pointer-like `path`, message, and severity. Consumers should branch on codes rather than message text.

Entity fields support scalar types, required/default/enum/range constraints, indexes, and explicit relations. Features may safely contribute internal fields and entities during compilation. Defaults that affect ownership, tenancy, or security are never silently inferred.

Compatibility policy: 0.2.x preserves valid v1 documents. Breaking input changes require a new specification version or a tested migration path.
