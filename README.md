# Typhex

A TypeScript ORM with **arrow-function query predicates**. Write queries as plain TypeScript — Typhex compiles them to safe, parameterized SQL at build time via a TypeScript compiler plugin.

**Documentation:** https://kalyvasio.github.io/typhex/

## Why Typhex?

```ts
// Predicates look like TypeScript. They compile to SQL.
const adults = await User.query().where((u) => u.age > 18).toArray();

// Closure variables are captured automatically — no boilerplate
const country = "US";
const fromUS = await User.query().where((u) => u.country === country).toArray();

// Relations in where() generate JOINs automatically
const alicePosts = await Post.query()
  .where((p) => p.author.name === "Alice")
  .toArray();
```

**Key benefits:**
- **Compile-time IR** — predicates compile to IR at build time via the TypeScript transformer; zero runtime parsing overhead
- **Type-safe** — TypeScript knows your table structure; no decorators or code generation
- **No SQL injection** — all queries are parameterized
- **Relations** — `manyToOne`, `oneToMany`, `oneToOne`, `manyToMany` with automatic JOINs and eager loading
- **Aggregations** — `GROUP BY`, `HAVING`, `sum/avg/min/max/count/distinct`
- **Transactions** — callback API with implicit propagation; explicit API for service-layer patterns

## Installation

```bash
npm install typhex better-sqlite3
npm install --save-dev ts-patch
```

> `better-sqlite3` includes a native addon. On macOS: `xcode-select --install`. On Linux: `apt install build-essential`.

For PostgreSQL: `npm install typhex pg`

## TypeScript Transformer Setup

Add the plugin to `tsconfig.json` and patch TypeScript once:

```json
{
  "compilerOptions": {
    "plugins": [{ "transform": "typhex/transformer" }]
  }
}
```

```bash
npx ts-patch install
```

From now on `tsc` compiles predicates to IR automatically and captures all closure variables.

## Quick Start

```ts
import { Db, Entity, createSqliteDriver, count } from "typhex";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
  country: "text",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

await User.query().insert({ name: "Alice", age: 30, country: "US" });
await User.query().insert({ name: "Bob", age: 25, country: "UK" });

// Arrow-function predicates — closure auto-captured by transformer
const country = "US";
const fromUS = await User.query().where((u) => u.country === country).toArray();

// Fluent chaining
const first = await User.query()
  .where((u) => u.age >= 25)
  .orderBy((u) => u.name, "asc")
  .first();

// Aggregations
const stats = await User.query()
  .select((u) => ({ country: u.country, total: count(u.id) }))
  .groupBy((u) => u.country)
  .toArray();

// Update and delete
await User.query().where((u) => u.name === "Bob").update({ age: 26 });
await User.query().where((u) => u.country === "UK").delete();
```

> **No transformer?** Typhex falls back to runtime parsing with Acorn — pass closure variables explicitly: `.where((u) => u.country === country, { country })`. Everything else is identical.

## Features

- **Fluent query API**: `.where()`, `.select()`, `.orderBy()`, `.limit()`, `.offset()`, `.toArray()`, `.first()`, `.count()`
- **CRUD**: `.insert()`, `.insertMany()`, `.update()`, `.patch()`, `.delete()`, `.findById()`
- **Upsert**: `.onConflict(cols).doUpdate()` / `.doNothing()`
- **Graph insert**: `.insertGraph()` — nested objects with auto-wired foreign keys and junction rows
- **Aggregations**: `.groupBy()`, `.having()`, `count/sum/avg/min/max/distinct/groupConcat`
- **Transactions**: callback API (AsyncLocalStorage propagation), explicit `beginTrx()`, nested savepoints
- **Relations**: `manyToOne`, `oneToMany`, `oneToOne`, `manyToMany`; `where()` generates JOINs / EXISTS; `select()` does eager loading
- **Entity classes**: lifecycle hooks (`beforeSave`), computed properties, instance `.save()` / `.delete()`
- **Migrations**: generate, run, and inspect schema migration files
- **SQLite + PostgreSQL** drivers
- **Debug**: `TYPHEX_DEBUG=1` logs all SQL and parameters

## Transactions

Typhex supports two transaction styles — a callback API with implicit propagation, and an explicit API for passing transactions through service layers.

### Callback API (`db.transaction`)

The callback API automatically propagates the active transaction to any `Entity.query()` call inside the callback, without needing to pass `trx` explicitly:

```ts
await db.transaction(async () => {
  // Uses the active transaction implicitly via AsyncLocalStorage
  await User.query().insert({ name: "Alice" });
  await Post.query().insert({ title: "Hello", authorId: 1 });
  // Auto-commits on success, auto-rolls-back on throw
});
```

### Explicit API (`db.beginTrx`)

Use `beginTrx()` when you need to control the transaction lifecycle manually — for example, to pass a `trx` handle into service functions:

```ts
async function createUserWithPosts(trx: Trx) {
  const user = await User.query(trx).insert({ name: "Alice" });
  await Post.query(trx).insert({ title: "Hello", authorId: user.id });
}

const trx = await db.beginTrx();
try {
  await createUserWithPosts(trx);
  await trx.commit();
} catch {
  await trx.rollback();
}
```

### Nested Transactions (Savepoints)

Both APIs support nesting. Each nested call creates a savepoint, so you can roll back only the inner operation:

```ts
await db.transaction(async (outer) => {
  await User.query(outer).insert({ name: "Alice" });

  await outer.transaction(async (inner) => {
    await Post.query(inner).insert({ title: "Draft" });
    throw new Error("discard draft"); // only rolls back the savepoint
  }).catch(() => {});

  // Alice was still inserted
});
```

### Transaction Options

```ts
// ANSI isolation level (PostgreSQL supports all four; SQLite only "SERIALIZABLE")
await db.transaction(fn, { isolationLevel: "SERIALIZABLE" });

// PostgreSQL: read-only, deferrable
await db.transaction(fn, { isolationLevel: "SERIALIZABLE", readOnly: true, deferrable: true });

// SQLite native modes: "deferred" (default) | "immediate" | "exclusive"
await db.beginTrx({ sqliteMode: "exclusive" });
```

## Architecture

Typhex uses a database-agnostic **IR (Intermediate Representation)**:

1. **Predicate → IR** — compiled at build time via the TypeScript transformer, or at runtime via the Acorn parser
2. **IR → SQL** — compiled to parameterized SQL by a dialect module (SQLite or PostgreSQL)
3. **Execution** — routed through a driver abstraction

See the [Architecture docs](https://kalyvasio.github.io/typhex/reference/architecture) for the IR node types, driver interface, and how to add a custom driver.

## Documentation

https://kalyvasio.github.io/typhex/

- [Getting Started](https://kalyvasio.github.io/typhex/guide/getting-started)
- [Entities & Relations](https://kalyvasio.github.io/typhex/guide/entities-relations)
- [Querying Relations](https://kalyvasio.github.io/typhex/guide/querying-relations)
- [Filtering by Relations](https://kalyvasio.github.io/typhex/guide/filtering-by-relations)
- [Aggregations](https://kalyvasio.github.io/typhex/guide/aggregations)
- [Transactions](https://kalyvasio.github.io/typhex/guide/transactions)
- [Bulk Operations](https://kalyvasio.github.io/typhex/guide/bulk-operations)
- [TypeScript Transformer](https://kalyvasio.github.io/typhex/guide/typescript-transformer)
- [SQLite](https://kalyvasio.github.io/typhex/drivers/sqlite) / [PostgreSQL](https://kalyvasio.github.io/typhex/drivers/postgres)
- [Migrations](https://kalyvasio.github.io/typhex/migrations/overview)
- [API Reference](https://kalyvasio.github.io/typhex/reference/api)
- [Architecture](https://kalyvasio.github.io/typhex/reference/architecture)

## Contributing

Contributions welcome! Areas for improvement:
- Additional database drivers (MySQL, etc.)
- More predicate operators and expression types
- Query optimization and caching

## License

MIT
