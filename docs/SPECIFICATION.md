# Specification reference

`backendcompiler.dev/v1` is the stable public input contract. A document is YAML or JSON with five top-level blocks:

```yaml
specVersion: backendcompiler.dev/v1   # required, exact string
project:                              # required
  name: my-api                        # required, ^[a-z][a-z0-9-]*$, 2-64 chars
  description: What this backend does # optional, max 500 chars
target:                               # required
  id: nestjs-prisma                   # required target id
  database: postgresql                # postgresql | mysql | sqlite (target decides support)
entities: {}                          # required, may be empty when features create all entities
features: {}                          # required, may be empty
options:                              # optional
  apiPrefix: api                      # ^[a-z0-9][a-z0-9/-]*$, max 32
  port: 3000                          # 1-65535
```

The authoritative machine-readable contract is [`packages/specification/schema/backend-spec.v1.schema.json`](../packages/specification/schema/backend-spec.v1.schema.json). This page restates it for humans and agents.

Validation has two stages: structural JSON Schema validation, then semantic compilation. Every error carries a stable `code`, a JSON-pointer `path`, and a message. Branch on codes, not message text.

## Entities

`entities` maps entity names (`^[A-Za-z][A-Za-z0-9_]*$`, conventionally PascalCase singular) to definitions:

```yaml
entities:
  Room:
    description: A bookable hotel room        # optional
    fields:                                   # required, at least one field
      number:
        type: string
        required: true
      capacity:
        type: integer
        minimum: 1
      status:
        type: string
        enum: [AVAILABLE, MAINTENANCE]
        default: AVAILABLE
      notes: text                             # shorthand: name -> type
    relations:
      - name: hotel                           # relation name, camelCase
        type: belongsTo                       # belongsTo | hasOne | hasMany | manyToMany
        target: Hotel                         # must reference a declared entity
        required: true                        # optional, default false
    indexes:
      - fields: [number, hotelId]             # field names, or relation foreign keys
        unique: true                          # optional, default false
```

### Field types

| Type | PostgreSQL mapping | Notes |
|---|---|---|
| `string` | `text` with length validation | Use `maxLength`; unbounded strings are rejected at the API layer defaults |
| `text` | `text` | Long-form content, no length validation by default |
| `integer` | `integer` | `minimum` / `maximum` supported |
| `decimal` | `decimal` | Money, coordinates; `minimum` / `maximum` supported |
| `boolean` | `boolean` | |
| `datetime` | `timestamptz` | ISO-8601 in the API |
| `date` | `date` | |
| `uuid` | `uuid` | |

### Field options

| Option | Applies to | Meaning |
|---|---|---|
| `required` | all | Non-null column, required in create DTOs. Default `false`. |
| `unique` | all | Unique constraint plus 409-mapped conflict handling. |
| `enum` | `string` | Closed value set (`^[A-Za-z][A-Za-z0-9_]*$` each); becomes a Prisma enum. |
| `default` | all | Literal database and DTO default. |
| `minimum` / `maximum` | `integer`, `decimal` | Server-side range validation. |
| `minLength` / `maxLength` | `string` | Server-side length validation. |
| `description` | all | Propagated to OpenAPI. |

### Relations

Declare one side only; the compiler derives the inverse (Prisma needs both). `belongsTo` and `hasOne` own the foreign key. The foreign key column is named `<relationName>Id` — `hotel` produces `hotelId` — and indexes may reference it.

## Features

`features` maps feature names to configuration objects. `{}` accepts all defaults. Each feature's options are validated against its own JSON Schema — run `backendgen describe-feature <name>` for the live contract, or see [FEATURE_PACKS.md](FEATURE_PACKS.md).

Feature packs may create entities (`reservations` owns `Reservation`; `auth` owns `RefreshSession`) and extend yours (`auth` adds `email`, `passwordHash`, `role` to the user entity). Declaring an entity a feature owns is a compile error with a stable code, never a silent merge.

## Semantic rules the schema cannot express

- Relation targets and feature entity references must exist (`semantic.unknown-relation-target`, `feature.missing-entity`).
- Index fields must be declared fields or relation foreign keys (`semantic.unknown-index-field`).
- `minLength <= maxLength`, `minimum <= maximum` (`semantic.invalid-length-range`, `semantic.invalid-number-range`).
- Ownership scoping requires `auth` (`feature.crud.ownership-requires-auth`).
- Overlap prevention requires PostgreSQL (`feature.reservations.overlap-unsupported`).
- The target must support the selected database (`target.unsupported-database`).

## Compatibility policy

0.2.x preserves valid v1 documents. Breaking input changes require a new specification version or a tested migration path.
