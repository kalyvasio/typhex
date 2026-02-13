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
users.where((u) => u.name.startsWith("A")).orderBy("age", "desc").first();
users.where((u) => u.id in [1, 2, 3]).count();
```

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
   const results = users
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
const matching = users
  .where((u) => u.name.startsWith("A"))
  .toArray();

// Array membership
const ids = [1, 2, 3];
const selected = users.where((u) => u.id in ids, { ids }).toArray();
```

### CRUD Operations

```ts
// Insert
const newId = users.insert({ name: "Charlie", age: 28, country: "CA" });

// Update
const updated = users.update(
  (u) => u.name === "Alice",
  { age: 31 }
);

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
  column: { type: "type", primaryKey: true, nullable: false }
});
db.migrate(); // Create tables
```

### Query Builder

```ts
table
  .where((entity) => predicate)
  .select(["col1", "col2"])  // Optional: select specific columns
  .orderBy("column", "asc" | "desc")
  .limit(n)
  .offset(n)
  .toArray()    // Execute and return array
  .first()      // Execute and return first result
  .count()      // Execute and return count
  .update(set)  // Update matching rows
  .delete()     // Delete matching rows
```

### CRUD

```ts
table.insert({ col1: value1, col2: value2 });  // Returns lastInsertRowid
table.update((e) => predicate, { col: value }); // Returns number of rows updated
table.delete((e) => predicate);                 // Returns number of rows deleted
table.findById(id);                              // Returns entity or undefined
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
