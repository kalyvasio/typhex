# CTEs and Unions

Common table expressions let you name an inner query and reuse it from an outer query. Typhex exposes them through `.withCte()`, `.withRecursiveCte()`, `.from()`, and `.unionAll()`.

## Basic CTE

Register a query with `.withCte(name, query)`, then read from it with `.from(name)`:

```ts
const adults = User.query().where((u) => u.age >= 18);

const workingAge = await User.query()
  .withCte("adults", adults)
  .from("adults")
  .where((u) => u.age < 65)
  .toArray();
```

```sql
WITH "adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0"
  WHERE ("t0"."age" >= ?)
)
SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
FROM "adults" AS "t0"
WHERE ("t0"."age" < ?)
-- params: [18, 65]
```

## Referencing Earlier CTEs

Later CTEs can read from earlier CTEs by using `.from("earlier_name")`:

```ts
const adults = User.query().where((u) => u.age >= 18);
const ukAdults = User.query()
  .from("adults")
  .where((u) => u.country === "UK");

const rows = await User.query()
  .withCte("adults", adults)
  .withCte("uk_adults", ukAdults)
  .from("uk_adults")
  .toArray();
```

```sql
WITH "adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0"
  WHERE ("t0"."age" >= ?)
), "uk_adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "adults" AS "t0"
  WHERE ("t0"."country" = ?)
)
SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
FROM "uk_adults" AS "t0"
WHERE 1=1
-- params: [18, "UK"]
```

Use this when the later CTE is a filtered subset of an earlier one. The inner query reads directly from the earlier CTE name.

## Correlating with `ctes.*` in WHERE

Sometimes the later CTE should scan the **base entity table** and correlate to an earlier CTE in `WHERE`, instead of using `.from("earlier_name")`. Typhex exposes earlier registered CTEs through a `ctes` context.

Typical shape:

```ts
const adults = User.query().where((u) => u.age >= 18);

await User.query()
  .withCte("adults", adults)
  .withCte("uk_adults", (ctes) =>
    User.query().where((u) => u.country === "UK" && u.id === ctes.adults.id),
  )
  .from("uk_adults")
  .toArray();
```

```sql
WITH "adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0"
  WHERE ("t0"."age" >= ?)
), "uk_adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0", "adults"
  WHERE ("t0"."country" = ?) AND ("t0"."id" = "adults"."id")
)
SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
FROM "uk_adults" AS "t0"
WHERE 1=1
-- params: [18, "UK"]
```

The important difference from `.from("adults")`:

| Approach                   | Inner `FROM`             | Typical use                                         |
| -------------------------- | ------------------------ | --------------------------------------------------- |
| `.from("adults")`          | `"adults"`               | Filter rows already materialized in the earlier CTE |
| `ctes.adults.*` in `WHERE` | base table + earlier CTE | Match base-table rows against earlier CTE rows      |

### Transformer: `ctes.*` in a single-arg `where`

When the Typhex transformer is enabled, reference earlier CTE columns directly inside a one-argument `where()` lambda. The transformer captures `ctes` from the `.withCte()` callback:

```ts
.withCte("uk_adults", (ctes) =>
  User.query().where((u) => u.country === "UK" && u.id === ctes.adults.id),
)
```

This is the pattern used in `examples/cte/cte.ts` section 3b.

### Runtime: two-arg `where((row, ctes) => ...)`

Without the transformer, pass the `ctes` object explicitly as the second parameter to `where()`. This works when building a later CTE body and when correlating mutations on the outer builder:

```ts
// Later CTE body — runtime-friendly
.withCte("uk_adults", () =>
  User.query().where(
    (u, ctes) => u.country === "UK" && u.id === ctes.adults.id,
  ),
)

// Outer UPDATE/DELETE on the same builder
await User.query()
  .withCte("adults", adults)
  .where((u, ctes) => u.age === 35 && u.id === ctes.adults.id)
  .update({ name: "Robert" });
```

```sql
WITH "adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0"
  WHERE ("t0"."age" >= ?)
)
UPDATE "users" AS "t0"
SET "name" = ?
FROM "adults"
WHERE ("t0"."age" = ?) AND ("t0"."id" = "adults"."id")
-- params: [18, "Robert", 35]
```

The two-arg form is the reliable way to correlate registered CTEs at runtime. The single-arg `ctes.adults.id` form inside a `.withCte()` callback requires the transformer.

## `UNION ALL`

Use `.unionAll()` to combine compatible SELECT branches, often inside a CTE:

```ts
const young = User.query().where((u) => u.age < 25);
const senior = User.query().where((u) => u.age >= 65);

const rows = await User.query()
  .withCte("ends", young.unionAll(senior))
  .from("ends")
  .orderBy("name", "asc")
  .toArray();
```

```sql
WITH "ends" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0"
  WHERE ("t0"."age" < ?)
  UNION ALL
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0"
  WHERE ("t0"."age" >= ?)
)
SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
FROM "ends" AS "t0"
WHERE 1=1
ORDER BY "t0"."name" ASC
-- params: [25, 65]
```

## Recursive CTEs

Recursive CTEs combine an anchor query with a recursive branch. The recursive branch refers to the CTE name via `.from(name)`:

```ts
const anchor = Category.query().where((c) => c.parentId === null);
const recursive = Category.query()
  .from("tree")
  .innerJoin(Category, (child, parent) => child.parentId === parent.id);

const tree = await Category.query()
  .withRecursiveCte("tree", anchor.unionAll(recursive))
  .from("tree")
  .toArray();
```

```sql
WITH RECURSIVE "tree" AS (
  SELECT "t0"."id", "t0"."name", "t0"."parentId"
  FROM "categories" AS "t0"
  WHERE ("t0"."parentId" IS NULL)
  UNION ALL
  SELECT "t0"."id", "t0"."name", "t0"."parentId"
  FROM "tree" AS "t0"
  INNER JOIN "categories" AS "t1"
    ON ("t1"."parentId" = "t0"."id")
)
SELECT "t0"."id", "t0"."name", "t0"."parentId"
FROM "tree" AS "t0"
WHERE 1=1
```

Entity-table joins such as `.innerJoin(Category, on)` are useful in recursive branches and self-joins.

## CTEs with Mutations

Registered CTEs can also constrain updates and deletes on the outer builder. Use the two-argument `where((row, ctes) => ...)` form to correlate the mutation target to a registered CTE:

```ts
const adults = User.query().where((u) => u.age >= 18);

await User.query()
  .withCte("adults", adults)
  .where((u, ctes) => u.id === ctes.adults.id && u.age === 35)
  .update({ name: "Robert" });
```

```sql
WITH "adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0"
  WHERE ("t0"."age" >= ?)
)
UPDATE "users" AS "t0"
SET "name" = ?
FROM "adults"
WHERE ("t0"."age" = ?) AND ("t0"."id" = "adults"."id")
-- params: [18, "Robert", 35]
```

For deletes, Typhex correlates through `EXISTS`:

```ts
const ukAdults = User.query().where((u) => u.country === "UK" && u.age >= 18);

await User.query()
  .withCte("uk_adults", ukAdults)
  .where((u, ctes) => u.age >= 65 && u.id === ctes.uk_adults.id)
  .delete();
```

```sql
WITH "uk_adults" AS (
  SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  FROM "users" AS "t0"
  WHERE (("t0"."country" = ?) AND ("t0"."age" >= ?))
)
DELETE FROM "users" AS "t0"
WHERE EXISTS (
  SELECT 1 FROM "uk_adults"
  WHERE ("t0"."age" >= ?) AND ("t0"."id" = "uk_adults"."id")
)
-- params: ["UK", 18, 65]
```

See the [API reference](/reference/api#withcte-name-query) for method signatures and run `npm run cte` from `examples/` for end-to-end output.
