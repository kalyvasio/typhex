# Typhex

A TypeScript/JavaScript ORM that supports **arrow-function query predicates** and standard ORM features: CRUD, migrations, fluent queries, and parameterized SQL.

## Features

- **Arrow-function `where`**: Use `db.users.where(u => u.age > 18)` or with params: `db.users.where(u => u.country === country, { country })`.
- **Runtime parsing**: In plain JS/TS, arrow functions are parsed from source (safe subset: comparisons, `&&`, `||`, `!`, `.startsWith`, `.includes`, `in`).
- **Optional compile-time transformer**: Use the TypeScript plugin to compile predicates to IR at build time for better perf and diagnostics.
- **Fluent API**: `.where()`, `.select()`, `.orderBy()`, `.limit()`, `.offset()`, `.toArray()`, `.first()`, `.count()`, `.update()`, `.delete()`.
- **CRUD**: `insert()`, `update()`, `delete()`, `findById()`.
- **Migrations**: `db.migrate()` creates tables from your schema (create-if-not-exists).
- **SQLite** driver out of the box; driver abstraction allows adding PostgreSQL etc.

## Install

```bash
npm install typhex better-sqlite3
```

> **Note:** `better-sqlite3` compiles a native addon. If you used `npm install --ignore-scripts`, run `npm rebuild better-sqlite3` (or a full `npm install`) before running the example.

## Quick start

```ts
import { Db, createSqliteDriver } from "typhex";

const driver = createSqliteDriver({ path: "./app.db" });
const db = new Db(driver);

const users = db.defineTable("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
  country: "text",
});

db.migrate();

// Query with arrow functions
const adults = users.where((u) => u.age > 18).toArray();
const fromUS = users.where((u) => u.country === country, { country: "US" }).toArray();

// Fluent
users.where((u) => u.age >= 25).orderBy("name", "asc").limit(10).toArray();
users.where((u) => u.id === id).first();
users.where((u) => u.country === "US").count();

// CRUD
users.insert({ name: "Alice", age: 30, country: "US" });
users.update((u) => u.name === "Bob", { age: 26 });
users.delete((u) => u.country === "UK");
```

## Supported predicate subset (runtime)

- Comparisons: `===`, `!==`, `==`, `!=`, `>`, `>=`, `<`, `<=`
- Logic: `&&`, `||`, `!`
- Member access: `u.name`, `u.profile.age`
- Literals: numbers, strings, `true`, `false`, `null`
- Params: use outer variables and pass `{ varName: value }` as second argument
- `in`: `ids.includes(u.id)`-style or `u.id in [1,2,3]` (array literal)
- String methods: `u.name.startsWith("A")`, `.endsWith()`, `.includes()`

## Compile-time transformer (optional)

For TypeScript projects you can compile predicates at build time:

1. Install [ttypescript](https://github.com/cevek/ttypescript) or [ts-patch](https://github.com/nonara/ts-patch).
2. In `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "transform": "typhex/transformer" }]
  }
}
```

3. Use `ttsc` instead of `tsc` (or run `tsc` with ts-patch). Calls like `.where(u => u.age > 18)` are rewritten to `.where(ir)` so no runtime parsing is needed.

## Relations

Load related rows by querying on foreign keys:

```ts
const posts = db.defineTable("posts", { id: "integer primary key", userId: "integer", title: "text" });

const userPosts = posts.where((p) => p.userId === userId).toArray();
```

Future versions may add `.include()` or relation helpers.

## License

MIT
