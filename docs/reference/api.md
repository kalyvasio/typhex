# API Reference

## `Entity(tableName, schema, relations?)`

Creates a base class for a database table.

```ts
const MyEntity = Entity(tableName: string, schema: Schema, relations?: Relations)
```

- **`tableName`** — SQL table name
- **`schema`** — Map of column names to SQL type strings (e.g., `"text not null"`, `"integer primary key autoincrement"`)
- **`relations`** — Optional map of relation names to relation definitions (see `rel` below)

Returns a class. Subclass it to add custom methods and lifecycle hooks. Call `.query()` on the class or an instance to get a query builder.

## `rel` Helpers

```ts
import { rel } from "typhex";
```

### `rel.manyToOne(targetFn, options)`

Defines a many-to-one (N:1) relation. The current table holds the foreign key.

```ts
rel.manyToOne(() => Company, { foreignKey: "companyId" });
```

| Option       | Type     | Description                                     |
| ------------ | -------- | ----------------------------------------------- |
| `foreignKey` | `string` | Column on this table that references the target |

### `rel.oneToMany(targetFn, options)`

Defines a one-to-many (1:N) relation. The target table holds the foreign key.

```ts
rel.oneToMany(() => Employee, { foreignKey: "departmentId" });
```

| Option       | Type     | Description                                           |
| ------------ | -------- | ----------------------------------------------------- |
| `foreignKey` | `string` | Column on the target table that references this table |

### `rel.oneToOne(targetFn, options)`

Defines a one-to-one (1:1) relation. The FK lives on this table.

```ts
rel.oneToOne(() => UserProfile, { foreignKey: "userId" });
```

| Option       | Type                 | Description                                    |
| ------------ | -------------------- | ---------------------------------------------- |
| `foreignKey` | `string \| string[]` | Column(s) on this table pointing to the target |

### `rel.manyToMany(targetFn, options)`

Defines a many-to-many (M:N) relation via a junction table.

```ts
rel.manyToMany(() => Tag, { junction: "post_tags", foreignKey: "postId", referenceKey: "tagId" });
```

| Option         | Type     | Description                          |
| -------------- | -------- | ------------------------------------ |
| `junction`     | `string` | Junction table name                  |
| `foreignKey`   | `string` | Column pointing to this entity       |
| `referenceKey` | `string` | Column pointing to the target entity |

See [Composite Primary Keys](/guide/entities-relations#composite-primary-keys) for multi-column PK and FK syntax.

## `Db`

### Constructor

```ts
new Db(driver: Driver)
new Db({ driver: Driver, migrationsFolder?: string })
new Db({ dialect: "sqlite", database: string, migrationsFolder?: string })
new Db({ dialect: "postgres", url: string, migrationsFolder?: string })
```

Sets the driver as the default for all entities registered in the current process.

### `Db.fromConfig(options?)`

Load `typhex.config.js` and create a database from it. This is the same config shape used by the CLI.

```ts
const db = await Db.fromConfig();
const db = await Db.fromConfig({ configPath: "./typhex.config.js" });
```

Config fields: `dialect`, `database` for SQLite, `url` for PostgreSQL, `migrationsFolder`, and `entities`.

### `db.migrate()`

Creates all registered tables that don't exist yet.

```ts
await db.migrate();
```

### `db.generateMigrations(dir)`

Diffs current entity definitions against existing migration files and writes new `.js` migration modules.

```ts
const files = await db.generateMigrations(dir: string)
// Returns: { name: string, upSql: string, downSql: string, content: string }[]
```

### `db.runMigrations(dir)`

Applies all pending migration modules in `dir`.

```ts
const result = await db.runMigrations(dir: string)
// Returns: { applied: string[], skipped: string[] }
```

### `db.migrationStatus(dir)`

Returns applied migration records and pending migration names.

```ts
const status = await db.migrationStatus(dir: string)
// Returns: { applied: MigrationRecord[], pending: string[] }
```

See the [Migrations guide](/migrations/overview) for the generated module format.

### `db.transaction(fn, options?)`

Run a callback inside a transaction with implicit propagation via AsyncLocalStorage.

```ts
await db.transaction(async (trx) => {
  await User.query().insert({ name: "Alice" });
  await Post.query().insert({ title: "Hello", authorId: 1 });
});
// rolls back automatically if fn throws
```

Options: `{ isolationLevel?: "SERIALIZABLE" | ... }` and for SQLite: `{ sqliteMode?: "deferred" | "immediate" | "exclusive" }`.

### `db.beginTrx(options?)`

Begin a transaction and return a `Trx` handle for explicit management.

```ts
const trx = await db.beginTrx();
try {
  await User.query(trx).insert({ name: "Alice" });
  await trx.commit();
} catch {
  await trx.rollback();
}
```

### `db.run(sql, params?)`

Execute raw SQL directly. Useful for DDL statements like creating junction tables.

```ts
await db.run("CREATE TABLE post_tags (postId INTEGER NOT NULL, tagId INTEGER NOT NULL)");
```

### `db.query(sql, params?)`

Execute a raw SQL query and return rows.

### `db.close()`

Closes the database connection / releases the connection pool.

```ts
await db.close();
```

## Query Builder

All methods below are available on `EntityClass.query()` and on instance `.query()`.

### `.where(predicate, closureVars?)`

Filter rows. `predicate` is an arrow function. With the transformer, closure variables are captured automatically; in runtime mode pass them as the second argument.

```ts
.where((u) => u.age > 18)
.where((u) => u.country === country)                       // transformer
.where((u) => u.country === country, { country })          // runtime fallback
.where((u) => u.company.name === "Acme")                   // generates JOIN
.where((d) => d.employees.some((e) => e.name === "Alice")) // generates EXISTS
.where((d) => d.employees.every((e) => e.active === true)) // generates NOT EXISTS
```

```sql
WHERE age > ?
WHERE country = ?
LEFT JOIN companies ON companies.id = users.companyId WHERE companies.name = ?
WHERE EXISTS (SELECT 1 FROM employees WHERE employees.departmentId = departments.id AND employees.name = ?)
WHERE NOT EXISTS (SELECT 1 FROM employees WHERE employees.departmentId = departments.id AND NOT (employees.active = ?))
```

### `.select(columnsOrLambda, closureVars?)`

Limit or reshape the result columns.

```ts
.select(["name", "country"])                         // column list
.select((u) => ({ userId: u.id, name: u.name }))     // projection with aliases
.select((o) => ({ revenue: o.price * o.qty }))       // computed projection
.select((o) => ({ smalls: sum(o.qty < cutoff ? 1 : 0) }), { cutoff }) // runtime closure
.select((p) => ({ ...p, author: p.author }))         // spread + relation
.select((u) => ({ posts: u.posts.query().select(…) })) // oneToMany sub-query
```

```sql
SELECT name AS name, country AS country FROM users
SELECT id AS userId, name AS name FROM users
SELECT (price * qty) AS revenue FROM orders
-- spread + relation: main query selects all own cols, relation fetched separately
-- oneToMany sub-query: main + child fetch via WHERE foreignKey IN (...)
```

### `.orderBy(column, direction?)`

```ts
.orderBy((u) => u.name, "asc")          // arrow form (preferred)
.orderBy((u) => u.age, "desc")
.orderBy((o) => o.price * o.qty, "desc") // expression
.orderBy((u) => u.company.name, "asc")  // relation column — generates JOIN
.orderBy("name", "asc")                 // string form also accepted
```

### `.limit(n)`

```ts
.limit(10)
```

### `.offset(n)`

```ts
.offset(20)
```

### `.withCte(name, query)`

Register a common table expression (`WITH name AS (…)`). The inner query is compiled when the outer query runs. Chain `.from(name)` on the outer query to read from the CTE.

```ts
const adults = User.query().where((u) => u.age >= 18);
const rows = await User.query()
  .withCte("adults", adults)
  .from("adults")
  .where((u) => u.age < 65)
  .toArray();
```

```sql
WITH "adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age"
  FROM "users" AS "t0"
  WHERE ("t0"."age" >= ?)
)
SELECT "t0"."id", "t0"."name", "t0"."age"
FROM "adults" AS "t0"
WHERE ("t0"."age" < ?)
-- params: [18, 65]
```

Later CTEs can reference earlier ones via `.from("earlier_name")`:

```ts
const adults = User.query().where((u) => u.age >= 18);
const ukAdults = User.query()
  .from("adults")
  .where((u) => u.country === "UK");
await User.query()
  .withCte("adults", adults)
  .withCte("uk_adults", ukAdults)
  .from("uk_adults")
  .toArray();
```

**Callback form** — build the inner query from the base table and correlate to earlier CTEs in `WHERE` (not `.from("earlier")`). Requires the Typhex transformer so `ctes.<name>.<column>` in a single-arg `where` is compiled to IR:

```ts
await User.query()
  .withCte("adults", adults)
  .withCte("uk_adults", (ctes) =>
    User.query().where((u) => u.country === "UK" && u.id === ctes.adults.id),
  )
  .from("uk_adults")
  .toArray();
```

```sql
-- uk_adults body: FROM "users" AS "t0", "adults" WHERE ... AND "t0"."id" = "adults"."id"
```

### `.withRecursiveCte(name, query)`

Register a recursive CTE (`WITH RECURSIVE name AS (…)`). The body should combine an anchor `SELECT` with a recursive step via `.unionAll()`. Use `.from(name)` inside the recursive branch for self-reference.

```ts
const anchor = User.query().where((u) => u.age >= 65);
const recursive = User.query()
  .from("seniors")
  .where((u) => u.age >= 100);
const body = anchor.unionAll(recursive);
const seniors = await User.query().withRecursiveCte("seniors", body).from("seniors").toArray();
```

For hierarchies, join the base entity table in the recursive step:

```ts
await Category.query()
  .withRecursiveCte(
    "tree",
    Category.query()
      .where((c) => c.parentId === null)
      .unionAll(
        Category.query()
          .from("tree")
          .innerJoin(Category, (child, parent) => child.parentId === parent.id),
      ),
  )
  .from("tree")
  .orderBy("name")
  .toArray();
```

### `.from(source?)`

Set the outer `FROM` source:

- omit — read from the entity's base table
- `string` — registered CTE name from `.withCte()` or `.withRecursiveCte()` on this builder
- `QueryBuilder` — inline subquery: `FROM (SELECT …) AS t0`

```ts
const inner = User.query().where((u) => u.age >= 18);
await User.query()
  .from(inner)
  .where((u) => u.country === "US")
  .toArray();
```

```sql
SELECT ... FROM (
  SELECT ... FROM "users" AS "t0" WHERE ("t0"."age" >= ?)
) AS "t0"
WHERE ("t0"."country" = ?)
```

### `.unionAll(other)`

Append a `UNION ALL` branch to the current `SELECT`. Used inside recursive CTE bodies together with `.withRecursiveCte()`, or to combine two filtered sets in a non-recursive CTE:

```ts
const young = User.query().where((u) => u.age < 25);
const senior = User.query().where((u) => u.age >= 65);
await User.query()
  .withCte("ends", young.unionAll(senior))
  .from("ends")
  .orderBy("name", "asc")
  .toArray();
```

### `.toArray()`

Execute and return all matching rows.

```ts
const rows = await query.toArray();
```

### `.first()`

Execute and return the first matching row, or `undefined`.

```ts
const row = await query.first();
```

### `.count()`

Execute and return how many rows the query would produce without `limit`, `offset`, or `orderBy`. With `groupBy`, counts groups rather than base rows (Objection.js `resultSize()` semantics).

The query is compiled as a subquery and wrapped:

```sql
SELECT COUNT(*) AS c FROM (<inner SELECT …>) AS "_count"
```

`limit`, `offset`, and `orderBy` are stripped from the inner SELECT; `where`, joins, `groupBy`, `having`, and CTEs are kept.

```ts
const n = await query.count();
await User.query().withCte("us_users", usOnly).from("us_users").count();
```

```sql
-- simple filter
SELECT COUNT(*) AS c FROM (
  SELECT "t0"."id", "t0"."name" FROM "users" AS "t0" WHERE ("t0"."country" = ?)
) AS "_count"

-- with CTE
SELECT COUNT(*) AS c FROM (
  WITH "us_users" AS (
    SELECT ... FROM "users" AS "t0" WHERE ("t0"."country" = ?)
  )
  SELECT ... FROM "us_users" AS "t0" WHERE 1=1
) AS "_count"
```

### `.insert(data)`

Insert a row and return the inserted entity (with auto-generated `id`).

```ts
const row = await Entity.query().insert({ name: "Alice", age: 30 });
```

### `.update(data)`

Update all rows matching the current `where()` predicate.

```ts
const updatedCount = await Entity.query().where(…).update({ age: 31 })
```

When `.withCte()` is registered on the same builder, correlate the base table to CTE rows via a second `where` argument or `ctes.<name>.<column>` in an update SET lambda. SQLite/Postgres emit `WITH … UPDATE … FROM <cte>` when the predicate references a registered CTE:

```ts
const adults = User.query().where((u) => u.age >= 18);
await User.query()
  .withCte("adults", adults)
  .where((u, ctes) => u.age === 35 && u.id === ctes.adults.id)
  .update({ name: "Robert" });
```

Returns the number of rows updated.

### `.delete()`

Delete all rows matching the current `where()` predicate.

```ts
const deletedCount = await Entity.query().where(…).delete()
```

With registered CTEs, correlation uses `WHERE EXISTS (SELECT 1 FROM <cte> WHERE …)`:

```ts
const ukAdults = User.query().where((u) => u.country === "UK" && u.age >= 18);
await User.query()
  .withCte("uk_adults", ukAdults)
  .where((u, ctes) => u.age >= 65 && u.id === ctes.uk_adults.id)
  .delete();
```

Returns the number of rows deleted.

### `.patch(data)`

Update matching rows and return the updated row (or `null` if no match).

```ts
const updated = await Entity.query()
  .where((u) => u.name === "Bob")
  .patch({ age: 26 });
// Returns: EntityInstance | null
```

### `.findById(id)`

Find a single row by primary key.

```ts
const row = await Entity.query().findById(1);
// Returns the row or null
```

### `.insertMany(rows)`

Insert multiple rows in one SQL statement. Returns the inserted rows on PostgreSQL; returns `[]` on SQLite.

```ts
await Product.query().insertMany([
  { sku: "W-001", name: "Widget", price: 999, stock: 100 },
  { sku: "G-001", name: "Gadget", price: 1499, stock: 50 },
]);
```

Chain `.onConflict(columns).doNothing()` or `.onConflict(columns).doUpdate(updateCols?)` for upsert behaviour.

### `.insertGraph(graph)`

Insert a nested object graph — parents before children, children with wired foreign keys, junction rows for many-to-many.

```ts
await Post.query().insertGraph({
  title: "Hello",
  author: { name: "Alice" }, // manyToOne parent
  tags: [{ name: "new-tag" }, { id: existingId }], // manyToMany: insert + link
});
```

Accepts a single object or an array. Participates in an active transaction when one is passed via `Entity.query(trx)`.

### `.groupBy(columnsOrFnOrPositional)`

Group results. Accepts a lambda, column name(s), or positional index.

```ts
.groupBy((o) => o.category)             // arrow form (preferred)
.groupBy((o) => o.category).groupBy((o) => o.status)  // multiple columns
.groupBy("category", "status")          // string form also accepted
.groupBy([1, 2])                        // positional
```

### `.having(predicate, closureVars?)`

Filter groups. Same arrow-function syntax as `.where()`.

```ts
.having((o) => count(o.id) > 1)
.having((o) => sum(o.price) >= minRevenue, { minRevenue }) // runtime mode
```

### `.innerJoin(keysOrFn)` / `.leftJoin(…)` / `.rightJoin(…)` / `.fullJoin(…)` / `.crossJoin(…)`

Override the join type for a specific relation (Typhex defaults to `LEFT JOIN` for relations used in `where()`).

```ts
Contact.query()
  .innerJoin((c) => c.company)
  .where((c) => c.company.name === "Acme");
```

Join an entity table directly with a custom `ON` predicate (for example when joining a recursive CTE to its base table, or self-joining for peer rows):

```ts
User.query()
  .innerJoin(User, (peer, u) => peer.country === u.country && peer.id !== u.id)
  .where((u) => u.name === "Alice");

Category.query()
  .from("tree")
  .innerJoin(Category, (child, parent) => child.parentId === parent.id);
```

```sql
SELECT ... FROM contacts
INNER JOIN companies ON companies.id = contacts.companyId
WHERE companies.name = ?
```

## Aggregate Functions

```ts
import { count, sum, avg, min, max, distinct } from "typhex";
import { groupConcat } from "typhex/sqlite"; // SQLite only
import { stringAgg, arrayAgg, jsonAgg } from "typhex/postgres"; // PostgreSQL only
```

| Function                 | SQL            | Notes                          |
| ------------------------ | -------------- | ------------------------------ |
| `count(col?)`            | `COUNT(col)`   | Omit arg for `COUNT(*)`        |
| `sum(expr)`              | `SUM(expr)`    | Accepts columns or expressions |
| `avg(expr)`              | `AVG(expr)`    | Accepts columns or expressions |
| `min(expr)`              | `MIN(expr)`    | Accepts columns or expressions |
| `max(expr)`              | `MAX(expr)`    | Accepts columns or expressions |
| `distinct(col)`          | `DISTINCT col` | Wrap inside another aggregate  |
| `groupConcat(col, sep?)` | `GROUP_CONCAT` | SQLite only                    |
| `stringAgg(col, sep)`    | `STRING_AGG`   | PostgreSQL only                |
| `arrayAgg(col)`          | `ARRAY_AGG`    | PostgreSQL only                |
| `jsonAgg(col)`           | `JSON_AGG`     | PostgreSQL only                |

Used inside `.select()` and `.having()` lambdas. Aggregate arguments can include arithmetic and ternaries, for example `sum(o.price * o.qty)` or `sum(o.active ? 1 : 0)`.

## `createSqliteDriver(options)`

```ts
import { createSqliteDriver } from "typhex";

createSqliteDriver({ path: string });
```

| Option | Description                         |
| ------ | ----------------------------------- |
| `path` | Path to `.db` file, or `":memory:"` |

## `createPostgresDriver(options)`

```ts
import { createPostgresDriver } from "typhex";

createPostgresDriver({ connectionString: string });
```

| Option                | Description                                                   |
| --------------------- | ------------------------------------------------------------- |
| `connectionString`    | PostgreSQL connection URI                                     |
| `url`                 | Alias for `connectionString`, useful in config files          |
| `host`                | Hostname when not using a connection string                   |
| `port`                | Port, default `5432`                                          |
| `database`            | Database name, default `"postgres"`                           |
| `user`                | Database user                                                 |
| `password`            | Database password                                             |
| `ssl`                 | SSL config forwarded to `pg`                                  |
| `poolMin`             | Minimum pool connections, default `2`                         |
| `poolMax`             | Maximum pool connections, default `10`                        |
| `idleTimeoutMs`       | Idle connection timeout in milliseconds, default `30000`      |
| `connectionTimeoutMs` | Pool connection timeout in milliseconds, default `5000`       |
| `statementTimeoutMs`  | PostgreSQL `statement_timeout` in milliseconds                |
| `logger`              | Custom pool error logger with an `error(message, err)` method |

## `createDriver(options)`

Create a driver from a discriminated options object:

```ts
import { createDriver } from "typhex";

const sqlite = createDriver({ dialect: "sqlite", path: "./app.db" });
const postgres = createDriver({ dialect: "postgres", url: process.env.DATABASE_URL });
```

## Supported Predicate Syntax

| Expression                  | SQL equivalent            | Notes                                          |
| --------------------------- | ------------------------- | ---------------------------------------------- |
| `u.age > 18`                | `age > ?`                 | `>`, `>=`, `<`, `<=`, `===`, `!==`, `==`, `!=` |
| `u.deletedAt === null`      | `deletedAt IS NULL`       | `!== null` emits `IS NOT NULL`                 |
| `u.active`                  | `active = 1`              | boolean truthy                                 |
| `!u.active`                 | `NOT active = 1`          | unary negation                                 |
| `u.a && u.b`                | `a AND b`                 |                                                |
| `u.a \|\| u.b`              | `a OR b`                  |                                                |
| `u.price * u.qty`           | `price * qty`             | arithmetic: `+`, `-`, `*`, `/`, `%`            |
| `u.flags & 4`               | `flags & ?`               | bitwise: `&`, `\|`, `^`, `<<`, `>>`, `~`       |
| `u.qty < 5 ? "s" : "l"`     | `CASE WHEN … THEN … END`  | works in predicates, projections, aggregates   |
| `u.name.startsWith("A")`    | `name LIKE 'A%'`          |                                                |
| `u.name.endsWith("z")`      | `name LIKE '%z'`          |                                                |
| `u.name.includes("al")`     | `name LIKE '%al%'`        |                                                |
| `u.id in [1, 2, 3]`         | `id IN (?, ?, ?)`         | literal array                                  |
| `u.id in ids`               | `id IN (?, …)`            | variable array (pass as closure)               |
| `!(u.id in [2])`            | `id NOT IN (?)`           | negated `in`                                   |
| `u.company.name === "Acme"` | `JOIN … WHERE …`          | manyToOne: generates JOIN                      |
| `d.employees.some(e => …)`  | `EXISTS (SELECT 1 …)`     | oneToMany: generates EXISTS                    |
| `d.employees.every(e => …)` | `NOT EXISTS (SELECT 1 …)` | oneToMany: no child may fail the predicate     |

**Supported in runtime mode:** ternaries, arithmetic, bitwise operators, strict null checks, computed projections, aggregate expressions, expression `orderBy()`, and `IN` subqueries passed through the params object.

**Transformer-only:** scalar correlated subqueries in `.select()`, comparison `.where()` predicates, and `.orderBy()`; inline nested subqueries that rely on closure capture.

**Not supported:** unsigned right shift (`>>>`), optional chaining, nullish coalescing, arbitrary function calls, `await`, `new`, `instanceof`, assignments, and loops.
