# Getting Started

## Installation

```bash
npm install typhex better-sqlite3
npm install --save-dev ts-patch
```

For PostgreSQL: `npm install typhex pg`

> Native addon? See the [SQLite driver](/drivers/sqlite#installation) page if `better-sqlite3` fails to build.

Then enable the [TypeScript transformer](/guide/typescript-transformer) — it auto-captures closure variables and eliminates runtime parsing overhead. Without it, Typhex falls back to runtime parsing with Acorn (you pass closure variables manually).

## Define a Schema

Use `Entity()` to define a table. Column types are SQL type strings passed through to `CREATE TABLE`.

```ts
import { Db, Entity, createSqliteDriver } from "typhex";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer not null",
  country: "text not null",
});
```

TypeScript infers the row type from the schema — no separate interface needed.

## Connect and Migrate

```ts
const db = new Db(createSqliteDriver({ path: "./app.db" }));
await db.migrate(); // creates tables that don't exist yet
```

Use `":memory:"` for tests and one-off scripts.

## Insert Rows

```ts
await User.query().insert({ name: "Alice", age: 30, country: "US" });
```

```sql
INSERT INTO users (name, age, country) VALUES (?, ?, ?)
-- params: ["Alice", 30, "US"]
```

`insert()` returns the inserted row with the auto-generated `id`.

## Query with Arrow Functions

With the transformer active, write predicates as plain TypeScript — closure variables are captured automatically:

```ts
const adults = await User.query()
  .where((u) => u.age > 18)
  .toArray();
```

```sql
SELECT id, name, age, country FROM users WHERE age > ?
-- params: [18]
```

Closure variables work without a second argument:

```ts
const country = "US";
const fromUS = await User.query()
  .where((u) => u.country === country)
  .toArray();
```

```sql
SELECT id, name, age, country FROM users WHERE country = ?
-- params: ["US"]
```

Multiple closure variables compose into `AND`:

```ts
const minAge = 25;
const maxAge = 35;
const inRange = await User.query()
  .where((u) => u.age >= minAge && u.age <= maxAge)
  .toArray();
```

```sql
SELECT id, name, age, country FROM users WHERE age >= ? AND age <= ?
-- params: [25, 35]
```

## Fluent Chaining

```ts
const oldest = await User.query()
  .where((u) => u.age >= 25)
  .orderBy((u) => u.age, "desc")
  .first();

const top10 = await User.query()
  .where((u) => u.age >= 25)
  .orderBy((u) => u.age, "desc")
  .limit(10)
  .toArray();
```

```sql
SELECT id, name, age, country FROM users
WHERE age >= ? ORDER BY age DESC LIMIT ?
-- first():    params: [25, 1]
-- toArray():  params: [25, 10]
```

`.first()` returns the first matching row or `undefined` (it sets `LIMIT 1` automatically). `.toArray()` returns all rows.

## Select Columns

```ts
// Column-name array
const names = await User.query().select(["name", "country"]).toArray();
```

```sql
SELECT name AS name, country AS country FROM users
```

```ts
// Lambda projection (with aliases)
const projected = await User.query()
  .select((u) => ({ userId: u.id, fullName: u.name }))
  .toArray();
```

```sql
SELECT id AS userId, name AS fullName FROM users
```

```ts
// Shorthand: select all
const all = await User.query()
  .select((u) => u)
  .toArray();

// Shorthand: single column
const ages = await User.query()
  .select((u) => u.age)
  .toArray();
```

Projection fields can also be computed expressions:

```ts
const labels = await User.query()
  .select((u) => ({
    name: u.name,
    decade: (u.age / 10) * 10,
    label: u.age >= 18 ? "adult" : "minor",
  }))
  .toArray();
```

In runtime mode, pass closure variables used inside `.select()` as the second argument. With the transformer enabled, they are captured automatically.

## String Predicates

`.startsWith()`, `.endsWith()`, and `.includes()` compile to SQL `LIKE`:

```ts
const a = await User.query()
  .where((u) => u.name.startsWith("A"))
  .toArray();
const al = await User.query()
  .where((u) => u.name.includes("al"))
  .toArray();
```

```sql
SELECT ... FROM users WHERE name LIKE ? || '%'   -- startsWith → params: ["A"]
SELECT ... FROM users WHERE name LIKE '%' || ? || '%'  -- includes → params: ["al"]
```

## Array Membership

```ts
const selected = await User.query()
  .where((u) => u.id in [1, 3])
  .toArray();
const excluded = await User.query()
  .where((u) => !(u.id in [2]))
  .toArray();
```

```sql
SELECT ... FROM users WHERE id IN (?, ?)    -- params: [1, 3]
SELECT ... FROM users WHERE id NOT IN (?)   -- params: [2]
```

Variable arrays work too — captured automatically with the transformer:

```ts
const ids = [1, 2];
const byIds = await User.query()
  .where((u) => u.id in ids)
  .toArray();
```

## Find by ID and Count

```ts
const user = await User.query().findById(1);
const n = await User.query()
  .where((u) => u.country === "US")
  .count();
```

```sql
SELECT ... FROM users WHERE id = ? LIMIT 1           -- params: [1]
SELECT COUNT(*) AS c FROM (
  SELECT ... FROM "users" AS "t0" WHERE ("t0"."country" = ?)
) AS "_count"                                        -- params: ["US"]
```

## Update, Patch, and Delete

```ts
const updated = await User.query()
  .where((u) => u.name === "Bob")
  .update({ age: 26 });
```

```sql
UPDATE users SET age = ? WHERE name = ?
-- params: [26, "Bob"]
```

```ts
const patched = await User.query()
  .where((u) => u.name === "Bob")
  .patch({ age: 26 });
// Same UPDATE as above, then a SELECT ... WHERE name = ? LIMIT 1 to return the row
```

```ts
const deleted = await User.query()
  .where((u) => u.country === "UK")
  .delete();
```

```sql
DELETE FROM users WHERE country = ?
-- params: ["UK"]
```

## Instance Save and Delete

```ts
const dave = new User({ name: "Dave", age: 35, country: "US" });
await dave.query().save(); // INSERT — populates dave.id
await dave.query().delete(); // DELETE WHERE id = ?
```

`save()` inserts when the primary key is unset and updates when it's already set.

## Debug Mode

```bash
TYPHEX_DEBUG=1 npx tsx your-script.ts
```

Logs every SQL statement and its parameters to the console — exactly the SQL shown alongside each example on this page. Accepts `1`, `true`, or `yes`.
