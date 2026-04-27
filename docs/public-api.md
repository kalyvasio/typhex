# Public API And Compatibility

This document defines the supported Typhex surface for a production release.
Anything not listed here should be treated as internal and may change between
minor versions.

## Supported Entry Points

### `typhex`

Use this entry point for application code.

Public runtime exports:

- `Db`
- `Trx`
- `QueryBuilder`
- `SingleRowQueryBuilder`
- `InsertBuilder`
- `Entity`
- `rel`
- `getPkColumnsFromSchema`
- `createDriver`
- `createSqliteDriver`
- `createPostgresDriver`
- Aggregate helpers: `count`, `sum`, `avg`, `min`, `max`, `distinct`
- Migration helpers: `diffSchema`, `generateMigrationFiles`, `runMigrations`, `migrationStatus`
- Config helpers: `loadConfig`

Public type exports:

**Relation field types (declare entity properties with these):**
`OneToMany`, `ManyToOne`, `OneToOne`, `ManyToMany`

**Entity and relation machinery:**
`AnyEntityClass`, `EntityBase`, `EntityClass`, `EntityClassOf`, `EntityInstance`, `EntityRow`,
`EntitySchema`, `EntityRelations`, `EntityFields`, `SelectRow`, `TableDef`, `RelationLoadedValue`,
`RelationTarget`, `EntityRelationProps`, `EntityRelationPropsLoaded`, `Row`,
`RelationDef`, `RelationsMap`, `RelationOptions`, `JunctionOptions`, `RelationKind`, `RelationType`,
`RelationQueryBuilder`, `RelationQueryable`, `RelatedEntityInstance`, `ManyRelation`, `SingleRelation`,
`ToEntityInstance`, `OneToOneDef`, `ManyToOneDef`, `OneToManyDef`, `ManyToManyDef`, `RegisteredEntity`

**Relation factory functions (named alternatives to `rel.*`):**
`oneToOne`, `manyToOne`, `oneToMany`, `manyToMany`

**Schema inference helpers:**
`InferTable`, `InferInsert`, `InferColumnType`, `Flatten`, `Mutable`,
`Materialized`, `MaterializeShape`, `SQLTypeMap`, `SQLToTS`, `ExtractSQLBase`,
`StripParens`, `IsNotNull`, `IsGenerated`, `HasDefault`, `OptionalOnInsert`

**Builder/executor types:**
`DbOptions`, `QueryExecutor`, `OrderDirection`

**Driver/config types:**
`Driver`, `Connection`, `ExecuteResult`, `TransactionOptions`,
`SqliteDriverOptions`, `CreateDriverOptions`, `PostgresDriverOptions`,
`ColumnDef`, `TyphexConfig`, `LoadConfigOptions`

**Migration types:**
`DiffAction`, `Dialect`, `MigrationFile`, `MigrationRecord`, `MigrationResult`

The IR types (`IrNode`, `IrOrderBy`, `IrSelect`), parser helpers
(`parseArrowToIr`, `parseArrowToIrSelect`), and `QueryState` are stripped
from the published `.d.ts` via TypeScript's `stripInternal` and the
`@internal` JSDoc tag — they're an internal protocol between the TypeScript
transformer and the runtime query builder. The internal QB helpers
(`expandWithSentinels`, `logSql`, `isDebugSqlEnabled`) are also stripped.

### `typhex/transformer`

Use this entry point only from TypeScript build configuration.

Public exports:

- Default transformer factory
- `createTyphexTransformer`

### `typhex/sqlite`

SQLite-specific entry point.

Public exports:

- `createSqliteDriver`
- SQLite aggregate helpers
- SQLite driver option types

### `typhex/postgres`

PostgreSQL-specific entry point.

Public exports:

- `createPostgresDriver`
- PostgreSQL aggregate helpers
- PostgreSQL driver option types

## Internal Modules

Imports from deep paths such as `typhex/dist/...`, `src/...`, `dbs/...`,
`parser/...`, `transformer/...`, or `orm/helpers/...` are unsupported. Users
should not rely on them unless a feature is explicitly promoted to one of the
public entry points above.

## Compatibility Matrix

| Component | Supported |
| --- | --- |
| Node.js | `>=18` |
| TypeScript | `>=5.0` peer dependency |
| Module format | ESM package (`"type": "module"`) |
| SQLite | `better-sqlite3` via `createSqliteDriver` |
| PostgreSQL | `pg` via `createPostgresDriver` |
| Runtime parser | Supported safe subset of arrow predicates |
| TypeScript transformer | Supported via `typhex/transformer` |

## Release Rules

- Patch releases may fix bugs without changing public signatures.
- Minor releases may add public APIs or extend supported IR/compiler shapes.
- Major releases are required for removing public exports, changing method
  return types, or changing documented behavior.
- Internal modules can change at any time unless they are promoted here first.

## Migration Guide Template

Every breaking release should include:

- What changed.
- Who is affected.
- Before/after code examples.
- Whether a codemod or mechanical migration is possible.
- Any runtime data/schema migration required.
