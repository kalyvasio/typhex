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
  SELECT ... FROM "users" AS "t0" WHERE ("t0"."age" >= ?)
)
SELECT ... FROM "adults" AS "t0" WHERE ("t0"."age" < ?)
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

The callback form of `.withCte()` is useful when the new CTE should scan the base table and correlate to earlier CTE rows:

```ts
await User.query()
  .withCte("adults", adults)
  .withCte("uk_adults", (ctes) =>
    User.query().where((u) => u.country === "UK" && u.id === ctes.adults.id),
  )
  .from("uk_adults")
  .toArray();
```

That callback form requires the TypeScript transformer when `ctes.<name>.<column>` is referenced inside a single-argument `where()` lambda.

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

Entity-table joins such as `.innerJoin(Category, on)` are useful in recursive branches and self-joins.

## CTEs with Mutations

Registered CTEs can also constrain updates and deletes. Use the two-argument `where((row, ctes) => ...)` form when correlating the mutation target to a CTE:

```ts
const adults = User.query().where((u) => u.age >= 18);

await User.query()
  .withCte("adults", adults)
  .where((u, ctes) => u.id === ctes.adults.id && u.age === 35)
  .update({ name: "Robert" });
```

See the [API reference](/reference/api#withcte-name-query) for method signatures and the runnable `examples/cte/` demo for end-to-end SQL output.
