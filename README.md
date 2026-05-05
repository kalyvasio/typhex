# Typhex

A TypeScript/JavaScript ORM that brings **arrow-function query predicates** to Node.js. Write queries using arrow functions like `User.query().where(u => u.age > 18)` — Typhex compiles them to safe, parameterized SQL.

## Why Typhex?

Typhex lets you write database queries using familiar JavaScript/TypeScript syntax:

```ts
// Instead of SQL strings or query builders...
const adults = await User.query().where((u) => u.age > 18).toArray();

// Use closure variables naturally (with transformer)
const country = "US";
const fromUS = await User.query().where((u) => u.country === country).toArray();
```

**Key benefits:**

- ✅ **Type-safe queries** — TypeScript knows your table structure
- ✅ **No SQL injection** — All queries are parameterized
- ✅ **Familiar syntax** — Write predicates like you write JavaScript
- ✅ **Zero runtime overhead** (with transformer) — Predicates compile to IR at build time
- ✅ **Works in plain JS** — Runtime parser supports a safe subset

## Features

### Arrow-Function Query Predicates

Write queries using arrow functions that feel like JavaScript:

```ts
await User.query().where((u) => u.age > 18 && u.active).toArray();
await User.query()
  .where((u) => u.name.startsWith("A"))
  .orderBy("age", "desc")
  .first();
await User.query().where((u) => u.id in [1, 2, 3]).count();
```

Subqueries are supported on the right-hand side of `in` / `!(... in ...)`. Build the inner query with `.select(p => p.colName)` (a single column) and reference it from the outer query:

```ts
// Runtime mode: pass the inner builder via the params object.
const activePostIds = Post.query()
  .where((p) => p.active === 1)
  .select((p) => p.id);

const authorsWithActivePosts = await Author.query()
  .where((a, posts) => a.postId in posts, { posts: activePostIds })
  .toArray();

// NOT IN works via negation:
await Author.query()
  .where((a, posts) => !(a.postId in posts), { posts: activePostIds })
  .toArray();
```

When using the transformer, the inner chain can be inlined directly inside the predicate — closure capture happens automatically:

```ts
// Transformer mode (TypeScript projects):
await Author.query()
  .where((a) => a.postId in Post.query().where((p) => p.active === 1).select((p) => p.id))
  .toArray();
```

#### Scalar, comparison, and ORDER BY subqueries (transformer-only)

Beyond `WHERE IN`, the transformer also supports subqueries as scalar values — in `.select()` projections, in `.where()` comparisons, and as `.orderBy()` sort keys. The inner chain ends in `.select(() => count())` (or another aggregate) to produce a single-row scalar; correlation against the outer row works through closure capture.

```ts
// Scalar subquery in SELECT — per-author post count, correlated.
await Author.query()
  .select((a) => ({
    name: a.name,
    postCount: Post.query()
      .where((p) => p.authorId === a.id)
      .select(() => count()),
  }))
  .toArray();

// Subquery aggregate in WHERE — authors with more than 1 post.
await Author.query()
  .where(
    (a) =>
      Post.query()
        .where((p) => p.authorId === a.id)
        .select(() => count()) > 1,
  )
  .toArray();

// Subquery in ORDER BY — sort authors by post count descending.
await Author.query()
  .orderBy(
    (a) =>
      Post.query()
        .where((p) => p.authorId === a.id)
        .select(() => count()),
    "desc",
  )
  .toArray();
```

These shapes require the transformer — the runtime parser only handles the `WHERE IN` form above.

### Two Modes: Runtime Parsing or Compile-Time Transformation

**Runtime mode** (works everywhere):

- Parses arrow functions from source using Acorn
- Supports a safe subset of JavaScript expressions
- Requires passing closure variables explicitly: `.where((u) => u.country === country, { country })`

**Transformer mode** (TypeScript projects):

- Compiles predicates to IR at build time
- **Auto-captures closure variables** — no need to pass them manually
- Zero runtime parsing overhead
- Better error messages and type checking

### Full ORM Features

- **Fluent query API**: `.where()`, `.select()`, `.orderBy()`, `.limit()`, `.offset()`, `.toArray()`, `.first()`, `.count()`
- **CRUD operations**: `insert()`, `update()`, `delete()`, `findById()`
- **Schema migrations**: `db.migrate()` creates tables from your definitions
- **SQLite driver** included; extensible driver architecture for PostgreSQL, MySQL, etc.
- **Debug**: set env `TYPHEX_DEBUG=1` (or `true`/`yes`) to log SQL and params to the console.

## Installation

```bash
npm install typhex better-sqlite3
```

> **Note:** `better-sqlite3` includes a native addon. If installation fails, ensure you have build tools installed. On macOS: `xcode-select --install`. On Linux: install `build-essential` or equivalent.

## Quick Start

### Basic Usage (Runtime Parsing)

```ts
import { Db, Entity, createSqliteDriver } from "typhex";

// Define your schema as an Entity
const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
  country: "text",
});

const db = new Db(createSqliteDriver({ path: "./app.db" }));

// Create tables
await db.migrate();

// Insert data
await User.query().insert({ name: "Alice", age: 30, country: "US" });
await User.query().insert({ name: "Bob", age: 25, country: "UK" });

// Query with arrow functions
const adults = await User.query().where((u) => u.age > 18).toArray();
console.log(adults); // [{ id: 1, name: "Alice", ... }, ...]

// Use closure variables (pass values explicitly in runtime mode)
const country = "US";
const fromUS = await User.query()
  .where((u) => u.country === country, { country })
  .toArray();

// Fluent queries
const first = await User.query()
  .where((u) => u.age >= 25)
  .orderBy("name", "asc")
  .first();

// Count
const n = await User.query().where((u) => u.country === "US").count();

// Update — chain .where(...).update(set)
await User.query().where((u) => u.name === "Bob").update({ age: 26 });

// Delete — chain .where(...).delete()
await User.query().where((u) => u.country === "UK").delete();
```

### With Transformer (Auto-Capture Closure Variables)

For TypeScript projects, use the compile-time transformer to automatically capture closure variables:

1. **Install ts-patch**:

   ```bash
   npm install --save-dev ts-patch
   ```

2. **Configure your `tsconfig.json`**:

   ```json
   {
     "compilerOptions": {
       "plugins": [{ "transform": "typhex/transformer" }]
     }
   }
   ```

3. **Patch TypeScript** (one-time setup):

   ```bash
   npx ts-patch install
   ```

4. **Write queries without passing closure variables**:

   ```ts
   const country = "US";
   const minAge = 25;

   // No second argument needed! Transformer auto-captures `country` and `minAge`
   const results = await User.query()
     .where((u) => u.country === country && u.age >= minAge)
     .toArray();
   ```

The transformer rewrites `.where((u) => u.country === country)` to `.where(ir, { country })` at compile time, so you get the convenience without runtime overhead.

## Supported Predicate Syntax

### Runtime Parser (Safe Subset)

The runtime parser supports a limited but practical subset of JavaScript:

**✅ Supported:**

- Comparisons: `===`, `!==`, `==`, `!=`, `>`, `>=`, `<`, `<=`
- Logical operators: `&&`, `||`, `!`
- Member access: `u.name`, `u.profile.age` (nested properties)
- Literals: numbers, strings, `true`, `false`, `null`
- Array literals: `[1, 2, 3]`
- `in` operator: `u.id in [1, 2, 3]` and the WHERE-IN subquery form (passing an inner builder via the params object)
- String methods: `u.name.startsWith("A")`, `.endsWith()`, `.includes()`
- Aggregates (in `.select()` / `.having()`): `count()`, `sum()`, `avg()`, `min()`, `max()`, plus `distinct(...)` and `groupConcat()` / `STRING_AGG()` / `ARRAY_AGG()` / `JSON_AGG()`
- Relation existential predicates: `d.employees.some(e => e.name === "Alice")` and `.every(...)`
- Relation query chains in `.select()`: `.query().where(...).orderBy(...).limit(...).offset(...).select(...)`
- Closure variables: pass as second argument — `.where((u) => u.country === country, { country })`

**❌ Not supported (runtime):**

- Arithmetic and bitwise operators (`+`, `-`, `*`, `/`, `%`, `&`, `|`, …)
- Ternary / conditional expressions (`a ? b : c`)
- Optional chaining (`?.`) and nullish coalescing (`??`)
- Function calls other than the string methods, aggregates, and relation chains listed above
- Loops, assignments, `await`, `new`, `instanceof`

**💡 Tip:** The transformer supports a broader subset since it operates on TypeScript's AST. Use the transformer for more complex predicates.

## Examples

### Basic Queries

```ts
// Simple filter
const activeUsers = await User.query().where((u) => u.active).toArray();

// Multiple conditions
const filtered = await User.query()
  .where((u) => u.age > 18 && u.country === "US")
  .orderBy("age", "desc")
  .limit(10)
  .toArray();

// String matching
const matching = await User.query().where((u) => u.name.startsWith("A")).toArray();

// Array membership
const ids = [1, 2, 3];
const selected = await User.query().where((u) => u.id in ids, { ids }).toArray();
```

### CRUD Operations

```ts
// Insert
const inserted = await User.query().insert({ name: "Charlie", age: 28, country: "CA" });

// Update — chain .where(...).update(set)
const updated = await User.query()
  .where((u) => u.name === "Alice")
  .update({ age: 31 });

// Delete — chain .where(...).delete()
const deleted = await User.query().where((u) => u.country === "UK").delete();

// Find by ID
const user = await User.query().findById(1);
```

You can also create an instance directly and persist it:

```ts
const dave = new User({ name: "Dave", age: 35, country: "US" });
await dave.query().save();        // INSERT, populates dave.id
await dave.query().delete();      // DELETE WHERE id = dave.id
```

### Relations (Manual Joins)

Typhex doesn't have built-in relations yet, but you can query related data:

```ts
const Post = Entity("posts", {
  id: "integer primary key",
  userId: "integer",
  title: "text",
});

// Get posts for a user
const userId = 1;
const userPosts = await Post.query()
  .where((p) => p.userId === userId, { userId })
  .toArray();
```

Future versions will add `.include()` and relation helpers.

## Transactions

Typhex supports two transaction styles — a callback API with implicit propagation, and an explicit API for passing transactions through service layers.

### Callback API (`db.transaction`)

The callback API automatically propagates the active transaction to any `Entity.query()` call inside the callback, without needing to pass `trx` explicitly:

```ts
await db.transaction(async (trx) => {
  // These use the active transaction implicitly via AsyncLocalStorage
  await User.query().insert({ name: "Alice" });
  await Post.query().insert({ title: "Hello", authorId: 1 });
  // Auto-commits on success, auto-rolls-back on throw
});
```

You can also pass `trx` explicitly if you prefer:

```ts
await db.transaction(async (trx) => {
  await User.query(trx).insert({ name: "Alice" });
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
await db.transaction(async (trx) => {
  await User.query(trx).insert({ name: "Alice" });

  await trx
    .transaction(async (nested) => {
      await Post.query(nested).insert({ title: "Draft" });
      throw new Error("discard draft"); // only rolls back the savepoint
    })
    .catch(() => {});

  // Alice was still inserted
});
```

### `Entity.transaction` Shorthand

If you have a default `Db` configured, you can use the static shorthand:

```ts
await User.transaction(async (trx) => {
  await User.query(trx).insert({ name: "Bob" });
});
```

### Transaction Options

Both `db.transaction(fn, options)` and `db.beginTrx(options)` accept a `TransactionOptions` object:

```ts
// ANSI isolation level (PostgreSQL supports all four; SQLite only supports "SERIALIZABLE")
await db.transaction(fn, { isolationLevel: "SERIALIZABLE" });

// PostgreSQL: read-only transaction
await db.transaction(fn, { readOnly: true });

// PostgreSQL: serializable, read-only, deferrable (lowest overhead for long-running read-only txns)
await db.transaction(fn, {
  isolationLevel: "SERIALIZABLE",
  readOnly: true,
  deferrable: true,
});

// SQLite: native transaction mode (overrides isolationLevel)
// "deferred" (default) | "immediate" | "exclusive"
await db.transaction(fn, { sqliteMode: "immediate" });
await db.beginTrx({ sqliteMode: "exclusive" });
```

**SQLite isolation level note:** SQLite does not support ANSI isolation levels other than `"SERIALIZABLE"` (mapped to `BEGIN IMMEDIATE`). Passing `"READ_COMMITTED"`, `"READ_UNCOMMITTED"`, or `"REPEATABLE_READ"` to a SQLite connection will throw an error. Use `sqliteMode` for fine-grained SQLite control.

## Architecture

Typhex uses a **query IR (Intermediate Representation)** that bridges JavaScript expressions and SQL:

1. **Predicate → IR**: Arrow functions are converted to IR (either at runtime via parsing or compile-time via transformer)
2. **IR → SQL**: The IR is compiled to parameterized SQL with proper escaping
3. **Execution**: SQL is executed through a driver abstraction (SQLite, PostgreSQL, etc.)

This architecture enables:

- Safe SQL generation (no injection)
- Cross-database compatibility (IR is database-agnostic)
- Performance (IR can be cached/optimized)
- Type safety (TypeScript knows your schema)

## API Reference

### Database & Entities

```ts
const db = new Db(driver);

const User = Entity("users", {
  column: "type constraints",
  // or
  column: { type: "type", primaryKey: true, nullable: false },
});

await db.migrate(); // Create tables
```

### Query Builder

All queries start from `Entity.query()` and return promises.

```ts
await User.query()
  .where((entity) => predicate)
  .select(["col1", "col2"]) // optional: select specific columns
  .orderBy("column", "asc" | "desc")
  .limit(n)
  .offset(n)
  .toArray(); // → entity[]

await User.query().where(...).first();   // → entity | undefined
await User.query().where(...).count();   // → number
await User.query().where(...).update(set);   // → number of rows updated
await User.query().where(...).delete();      // → number of rows deleted
```

### CRUD

```ts
await User.query().insert({ col1: value1, col2: value2 }); // → inserted entity
await User.query().findById(id);                            // → entity | null
```

Instance form (works on entities created with `new User({...})`):

```ts
const u = new User({ name: "Dave", age: 35 });
await u.query().save();    // INSERT, populates u.id
await u.query().delete();  // DELETE WHERE id = u.id
```

## Contributing

Contributions welcome! Open areas:

- Additional database drivers (MySQL — SQLite and PostgreSQL ship today)
- Broader predicate syntax (arithmetic, ternaries, optional chaining, nullish coalescing)
- More scalar subquery shapes and runtime-parser support for the transformer-only forms
- Query optimization (planner improvements, plan caching)

## License

MIT
