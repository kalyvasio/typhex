# Typhex

[![CI](https://github.com/kalyvasio/typhex/actions/workflows/ci.yml/badge.svg)](https://github.com/kalyvasio/typhex/actions/workflows/ci.yml)
[![Docs](https://github.com/kalyvasio/typhex/actions/workflows/docs.yml/badge.svg)](https://github.com/kalyvasio/typhex/actions/workflows/docs.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A TypeScript/JavaScript ORM that lets you write SQL queries with arrow-function predicates:

```ts
const adults = await User.query()
  .where((u) => u.age > 18)
  .toArray();
```

Typhex compiles those predicates to safe, parameterized SQL through either a TypeScript transformer or a runtime parser.

## Why Typhex?

- **Type-safe queries**: TypeScript understands your entity shape.
- **No SQL injection**: Generated SQL is parameterized.
- **Familiar syntax**: Write predicates like normal JavaScript/TypeScript expressions.
- **Compile-time mode**: The transformer auto-captures closure variables and avoids runtime parsing.
- **Runtime fallback**: Plain JavaScript and direct `tsx` scripts work with explicit closure variables.
- **ORM features**: Relations, aggregations, transactions, bulk inserts, upserts, and graph inserts.

## Installation

For SQLite:

```bash
npm install typhex better-sqlite3
```

For PostgreSQL:

```bash
npm install typhex pg
```

For TypeScript projects, install the transformer tooling too:

```bash
npm install --save-dev ts-patch
```

`better-sqlite3` includes a native addon. If installation fails, install local build tools first: `xcode-select --install` on macOS, or `build-essential` or equivalent on Linux.

## Quick Start

### Define a Schema

```ts
import { Db, Entity, createSqliteDriver } from "typhex";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer not null",
  country: "text not null",
});
```

### Connect and Migrate

```ts
const db = new Db(createSqliteDriver({ path: "./app.db" }));

await db.migrate();
```

### Insert Rows

```ts
await User.query().insert({ name: "Alice", age: 30, country: "US" });
await User.query().insert({ name: "Bob", age: 25, country: "UK" });
```

### Query Rows

```ts
const adults = await User.query()
  .where((u) => u.age > 18)
  .orderBy((u) => u.name, "asc")
  .toArray();

const firstAdult = await User.query()
  .where((u) => u.age > 18)
  .first();

const alice = await User.query().findById(1);
const usCount = await User.query()
  .where((u) => u.country === "US")
  .count();
```

### Update, Patch, and Delete

```ts
await User.query()
  .where((u) => u.name === "Bob")
  .update({ age: 26 });

const updated = await User.query()
  .where((u) => u.name === "Alice")
  .patch({ country: "CA" });

await User.query()
  .where((u) => u.country === "UK")
  .delete();
```

`update()` returns the number of rows changed. `patch()` performs the update and returns the updated row.

## Runtime vs Transformer Mode

Typhex has two ways to turn arrow functions into query IR.

### Runtime Mode

Runtime mode works in JavaScript, direct `tsx` scripts, and projects without a TypeScript compiler plugin. Closure variables must be passed explicitly:

```ts
const country = "US";

const users = await User.query()
  .where((u) => u.country === country, { country })
  .toArray();
```

### Transformer Mode

Transformer mode is recommended for TypeScript projects. It compiles predicates at build time and auto-captures closure variables.

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

After setup, no second argument is needed:

```ts
const country = "US";
const minAge = 25;

const users = await User.query()
  .where((u) => u.country === country && u.age >= minAge)
  .toArray();
```

See the [TypeScript transformer guide](docs/guide/typescript-transformer.md) for setup details and dev-time notes.

## Querying

### Filtering, Ordering, and Paging

```ts
const users = await User.query()
  .where((u) => u.age >= 18 && u.country === "US")
  .orderBy((u) => u.age, "desc")
  .limit(10)
  .offset(20)
  .toArray();
```

### Selecting Columns

```ts
const names = await User.query().select(["name", "country"]).toArray();

const projected = await User.query()
  .select((u) => ({ userId: u.id, displayName: u.name }))
  .toArray();
```

### String Predicates and IN

```ts
const matching = await User.query()
  .where((u) => u.name.startsWith("A") || u.name.includes("son"))
  .toArray();

const ids = [1, 2, 3];
const selected = await User.query()
  .where((u) => u.id in ids, { ids })
  .toArray();
```

With the transformer enabled, captured arrays do not need the second argument.

### Subqueries

`IN` and `NOT IN` subqueries work in runtime and transformer mode. Runtime mode passes the inner query through the params object:

```ts
const activePostIds = Post.query()
  .where((p) => p.active === 1)
  .select((p) => p.id);

const authors = await Author.query()
  .where((a, posts) => a.postId in posts, { posts: activePostIds })
  .toArray();
```

Transformer mode can inline the inner query:

```ts
const authors = await Author.query()
  .where(
    (a) =>
      a.postId in
      Post.query()
        .where((p) => p.active === 1)
        .select((p) => p.id),
  )
  .toArray();
```

Scalar subqueries in `.select()`, `.where()` comparisons, and `.orderBy()` are transformer-only. See the [Subqueries guide](docs/guide/subqueries.md) for the supported shapes.

### CTEs and Unions

Use common table expressions when an inner query should be named and reused by an outer query:

```ts
const adults = User.query().where((u) => u.age >= 18);

const workingAge = await User.query()
  .withCte("adults", adults)
  .from("adults")
  .where((u) => u.age < 65)
  .toArray();
```

Typhex also supports `unionAll()`, recursive CTEs, entity-table joins for recursive branches, and CTE-correlated `update()` / `delete()`. See the [CTEs and Unions guide](docs/guide/cte-and-unions.md).

## Supported Predicate Syntax

Runtime mode supports a practical safe subset:

- Comparisons: `===`, `!==`, `==`, `!=`, `>`, `>=`, `<`, `<=`
- Logical operators: `&&`, `||`, `!`
- Member access, literals, array literals, and the `in` operator
- String methods: `.startsWith()`, `.endsWith()`, `.includes()`
- Aggregates in `.select()` and `.having()`: `count()`, `sum()`, `avg()`, `min()`, `max()`, `distinct(...)`
- Relation predicates such as `department.employees.some((e) => e.name === "Alice")`
- Universal relation predicates such as `department.employees.every((e) => e.active === true)`
- Relation query chains in `.select()`

Computed expressions (ternaries, arithmetic, bitwise operators, null checks) are also supported — see the [Expressions guide](docs/guide/expressions.md).

Runtime mode does not support unsigned right shift (`>>>`), optional chaining, nullish coalescing, arbitrary function calls, loops, assignments, `await`, `new`, or `instanceof`.

## Relations

Declare relations as the third argument to `Entity()`:

```ts
import { Entity, rel } from "typhex";

const Post = Entity(
  "posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    authorId: "integer not null",
  },
  {
    author: rel.manyToOne(() => User, { foreignKey: "authorId" }),
  },
);
```

Then use relation properties in `select()` and `where()`:

```ts
const posts = await Post.query()
  .where((p) => p.author.country === "US")
  .select((p) => ({ id: p.id, title: p.title, author: p.author }))
  .toArray();
```

Typhex supports `manyToOne`, `oneToMany`, `oneToOne`, and `manyToMany` relations. Relation selects avoid N+1 queries by batching related rows.

See [Entities & Relations](docs/guide/entities-relations.md), [Querying Relations](docs/guide/querying-relations.md), and [Filtering by Relations](docs/guide/filtering-by-relations.md).

## Aggregations

```ts
import { count, sum } from "typhex";

const statsByCountry = await User.query()
  .select((u) => ({ country: u.country, users: count(u.id), totalAge: sum(u.age) }))
  .groupBy((u) => u.country)
  .having((u) => count(u.id) > 1)
  .toArray();
```

Typhex supports `GROUP BY`, `HAVING`, `distinct()`, and database-specific aggregates such as SQLite `groupConcat()` and PostgreSQL `stringAgg()`, `arrayAgg()`, and `jsonAgg()`.

See the [Aggregations guide](docs/guide/aggregations.md).

## Bulk and Graph Operations

### Bulk Inserts

```ts
await Product.query().insertMany([
  { sku: "W-001", name: "Widget", price: 999 },
  { sku: "G-001", name: "Gadget", price: 1499 },
]);
```

### Upserts

```ts
await Product.query()
  .insert({ sku: "W-001", name: "Widget v2", price: 1099 })
  .onConflict(["sku"])
  .doUpdate(["name", "price"]);
```

### Graph Inserts

```ts
const post = await Post.query().insertGraph({
  title: "Hello",
  author: { name: "Alice" },
  tags: [{ name: "typescript" }, { name: "orm" }],
});
```

See the [Bulk Operations guide](docs/guide/bulk-operations.md).

## Transactions

Use `db.transaction()` for callback-style transactions with implicit propagation:

```ts
await db.transaction(async () => {
  const user = await User.query().insert({ name: "Alice", age: 30, country: "US" });
  await Post.query().insert({ title: "Hello", authorId: user.id });
});
```

Use `db.beginTrx()` when you need to pass a transaction handle through service layers:

```ts
const trx = await db.beginTrx();

try {
  await User.query(trx).insert({ name: "Bob", age: 26, country: "UK" });
  await trx.commit();
} catch {
  await trx.rollback();
}
```

Nested transactions use savepoints. Transaction options include isolation level, PostgreSQL read-only/deferrable flags, and SQLite transaction mode.

See the [Transactions guide](docs/guide/transactions.md).

## Debugging

Set `TYPHEX_DEBUG=1` to log SQL and parameters:

```bash
TYPHEX_DEBUG=1 npx tsx your-script.ts
```

`true` and `yes` are also accepted.

## Architecture

Typhex uses a query IR (Intermediate Representation) that bridges arrow-function predicates and SQL:

1. Arrow functions are converted to IR through the runtime parser or TypeScript transformer.
2. The SQL compiler turns IR into dialect-specific, parameterized SQL.
3. The driver executes SQL through SQLite, PostgreSQL, or a custom backend.

See the [Architecture reference](docs/reference/architecture.md).

## Documentation

- [Getting Started](docs/guide/getting-started.md)
- [TypeScript Transformer](docs/guide/typescript-transformer.md)
- [Entities & Relations](docs/guide/entities-relations.md)
- [Querying Relations](docs/guide/querying-relations.md)
- [Filtering by Relations](docs/guide/filtering-by-relations.md)
- [Expressions](docs/guide/expressions.md)
- [Aggregations](docs/guide/aggregations.md)
- [Subqueries](docs/guide/subqueries.md)
- [CTEs and Unions](docs/guide/cte-and-unions.md)
- [Bulk Operations](docs/guide/bulk-operations.md)
- [Transactions](docs/guide/transactions.md)
- [Migrations](docs/migrations/overview.md)
- [SQLite Driver](docs/drivers/sqlite.md)
- [PostgreSQL Driver](docs/drivers/postgres.md)
- [API Reference](docs/reference/api.md)

## Contributing

Contributions welcome. Open areas include:

- Additional database drivers
- Broader runtime predicate syntax
- Runtime support for transformer-only scalar subquery shapes

## License

MIT
