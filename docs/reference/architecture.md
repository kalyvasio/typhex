# Architecture

## Query Pipeline

Every Typhex query follows the same pipeline regardless of which mode (runtime or transformer) is used:

```
Arrow function
      │
      ▼
┌──────────────────────────────────────────────────┐
│  Parser (runtime: Acorn)  or  Transformer (tsc)  │
└──────────────────────────────────────────────────┘
      │
      ▼  Intermediate Representation (IR)
┌─────────────────────┐
│  SQL Compiler       │  dialect-specific: SQLite or PostgreSQL
└─────────────────────┘
      │
      ▼  SQL + parameters
┌─────────────────────┐
│  Driver             │  better-sqlite3 / pg / custom
└─────────────────────┘
      │
      ▼
   Database
```

Both modes produce the same IR and therefore the same SQL output. See [TypeScript Transformer](/guide/typescript-transformer) for setup.

## Intermediate Representation (IR)

The IR is a tree of typed nodes that describes a predicate or projection in a database-agnostic form. The SQL compiler walks this tree to produce parameterized SQL.

Key IR node types:

| Node | Description |
|------|-------------|
| `IrBinary` | Binary operator: `=`, `!=`, `>`, `>=`, `<`, `<=`, `AND`, `OR` |
| `IrUnary` | Unary operator: `NOT` |
| `IrMember` | Column access: `u.name` → `"name"` |
| `IrConst` | Literal value: number, string, boolean, null |
| `IrParam` | Closure variable: bound at execution time |
| `IrCall` | Method call: `startsWith`, `endsWith`, `includes` |
| `IrIn` | Array membership: `id IN (...)` |
| `IrExists` | EXISTS subquery (for `oneToMany` `.some()` predicates) |
| `IrSelect` | Projection descriptor: paths and aliases |

## Driver Abstraction

The `Driver` interface is the boundary between the query engine and the database:

```ts
interface Driver {
  readonly dialect: Dialect;
  connect(): Promise<Connection>;
  createTrx(conn: Connection, options?: TransactionOptions): Trx;
  close(): Promise<void>;
}

interface Connection {
  readonly dialect: Dialect;
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
  release(): Promise<void>;
}
```

Built-in drivers wrap `better-sqlite3` and `pg.Pool`. Implementing this interface (and a matching SQL dialect) is enough to add a new database backend.

## SQL Dialects

The shared IR is compiled to SQL by dialect modules. The two built-in dialects (SQLite and PostgreSQL) share most logic and differ mainly in:

- Parameter placeholder style (`?` vs `$1`, `$2`, …)
- `INSERT ... RETURNING` support (PostgreSQL only)
- `ON CONFLICT` syntax variations
- Database-specific aggregates (`groupConcat` vs `stringAgg` / `arrayAgg` / `jsonAgg`)

## Schema Registry

`Entity()` registers each table definition in a global registry. When `new Db(driver)` is called, it sets the driver as the default for all registered entities, and `db.migrate()` iterates the registry to create missing tables.

This design means you don't need to pass a `db` instance to every query — the driver is resolved automatically from the registry.
