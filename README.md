# Typhex

A TypeScript/JavaScript ORM that brings **arrow-function query predicates** to Node.js. Write queries using arrow functions like `users.where(u => u.age > 18)` — Typhex compiles them to safe, parameterized SQL.

## Why Typhex?

Typhex lets you write database queries using familiar JavaScript/TypeScript syntax:

```ts
// Instead of SQL strings or query builders...
const adults = users.where((u) => u.age > 18).toArray();

// Use closure variables naturally (with transformer)
const country = "US";
const fromUS = users.where((u) => u.country === country).toArray();
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
users.where((u) => u.age > 18 && u.active).toArray();
users
  .where((u) => u.name.startsWith("A"))
  .orderBy("age", "desc")
  .first();
users.where((u) => u.id in [1, 2, 3]).count();
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
import { Db, createSqliteDriver } from "typhex";

const driver = createSqliteDriver({ path: "./app.db" });
const db = new Db(driver);

// Define your schema
const users = db.defineTable("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
  country: "text",
});

// Create tables
db.migrate();

// Insert data
users.insert({ name: "Alice", age: 30, country: "US" });
users.insert({ name: "Bob", age: 25, country: "UK" });

// Query with arrow functions
const adults = users.where((u) => u.age > 18).toArray();
console.log(adults); // [{ id: 1, name: "Alice", ... }, ...]

// Use closure variables (pass values explicitly)
const country = "US";
const fromUS = users.where((u) => u.country === country, { country }).toArray();

// Fluent queries
const first = users
  .where((u) => u.age >= 25)
  .orderBy("name", "asc")
  .limit(1)
  .first();

// Count
const n = users.where((u) => u.country === "US").count();

// Update
users.update((u) => u.name === "Bob", { age: 26 });

// Delete
users.delete((u) => u.country === "UK");
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
   const results = users.where((u) => u.country === country && u.age >= minAge).toArray();
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
- `in` operator: `u.id in [1, 2, 3]`
- String methods: `u.name.startsWith("A")`, `.endsWith()`, `.includes()`
- Closure variables: Pass as second argument: `.where((u) => u.country === country, { country })`

**❌ Not supported (runtime):**

- Function calls (except `.startsWith`, `.endsWith`, `.includes`)
- Loops, ternaries, assignments
- `await`, `new`, `instanceof`
- Complex expressions

**💡 Tip:** The transformer supports a broader subset since it operates on TypeScript's AST. Use the transformer for more complex predicates.

## Examples

### Basic Queries

```ts
// Simple filter
const activeUsers = users.where((u) => u.active).toArray();

// Multiple conditions
const filtered = users
  .where((u) => u.age > 18 && u.country === "US")
  .orderBy("age", "desc")
  .limit(10)
  .toArray();

// String matching
const matching = users.where((u) => u.name.startsWith("A")).toArray();

// Array membership
const ids = [1, 2, 3];
const selected = users.where((u) => u.id in ids, { ids }).toArray();
```

### CRUD Operations

```ts
// Insert
const newId = users.insert({ name: "Charlie", age: 28, country: "CA" });

// Update
const updated = users.update((u) => u.name === "Alice", { age: 31 });

// Delete
const deleted = users.delete((u) => u.country === "UK");

// Find by ID
const user = users.findById(1);
```

### Relations (Manual Joins)

Typhex doesn't have built-in relations yet, but you can query related data:

```ts
const posts = db.defineTable("posts", {
  id: "integer primary key",
  userId: "integer",
  title: "text",
});

// Get posts for a user
const userId = 1;
const userPosts = posts.where((p) => p.userId === userId, { userId }).toArray();
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

### Database & Tables

```ts
const db = new Db(driver);
const table = db.defineTable<T>("tableName", {
  column: "type constraints",
  // or
  column: { type: "type", primaryKey: true, nullable: false },
});
db.migrate(); // Create tables
```

### Query Builder

```ts
table
  .where((entity) => predicate)
  .select(["col1", "col2"]) // Optional: select specific columns
  .orderBy("column", "asc" | "desc")
  .limit(n)
  .offset(n)
  .toArray() // Execute and return array
  .first() // Execute and return first result
  .count() // Execute and return count
  .update(set) // Update matching rows
  .delete(); // Delete matching rows
```

### CRUD

```ts
table.insert({ col1: value1, col2: value2 }); // Returns lastInsertRowid
table.update((e) => predicate, { col: value }); // Returns number of rows updated
table.delete((e) => predicate); // Returns number of rows deleted
table.findById(id); // Returns entity or undefined
```

## Contributing

Contributions welcome! Areas for improvement:

- Additional database drivers (PostgreSQL, MySQL, etc.)
- Built-in relations and joins
- More predicate operators
- Query optimization
- Migration system enhancements

## License

MIT
