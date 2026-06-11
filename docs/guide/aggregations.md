# Aggregations

Typhex supports `GROUP BY`, `HAVING`, and all standard aggregate functions. Import the aggregate helpers alongside your entities.

```ts
import { Db, Entity, createSqliteDriver, count, sum, avg, min, max, distinct } from "typhex";
import { groupConcat } from "typhex/sqlite"; // SQLite-specific
import { stringAgg, arrayAgg, jsonAgg } from "typhex/postgres"; // PostgreSQL-specific
```

## Aggregate Functions

Use aggregate functions inside a `.select()` lambda:

```ts
const Order = Entity("orders", {
  id: "integer primary key autoincrement",
  category: "text not null",
  status: "text not null",
  price: "integer not null",
});

// Single aggregate — total count
const total = await Order.query()
  .select((o) => count(o.id))
  .toArray();
```

```sql
SELECT COUNT(id) AS total FROM orders
```

```ts
// Multiple aggregates
const stats = await Order.query()
  .select((o) => ({
    total: count(o.id),
    minPrice: min(o.price),
    maxPrice: max(o.price),
    avgPrice: avg(o.price),
  }))
  .toArray();
```

```sql
SELECT COUNT(id) AS total, MIN(price) AS minPrice,
       MAX(price) AS maxPrice, AVG(price) AS avgPrice
FROM orders
```

| Function        | SQL            | Notes                         |
| --------------- | -------------- | ----------------------------- |
| `count(col?)`   | `COUNT(col)`   | Omit arg for `COUNT(*)`       |
| `sum(col)`      | `SUM(col)`     |                               |
| `avg(col)`      | `AVG(col)`     |                               |
| `min(col)`      | `MIN(col)`     |                               |
| `max(col)`      | `MAX(col)`     |                               |
| `distinct(col)` | `DISTINCT col` | Wrap inside another aggregate |

## GROUP BY

Pass an arrow function — the preferred form:

```ts
// Single column
const revenueByCategory = await Order.query()
  .select((o) => ({ category: o.category, revenue: sum(o.price) }))
  .groupBy((o) => o.category)
  .toArray();
```

```sql
SELECT category AS category, SUM(price) AS revenue
FROM orders
GROUP BY category
```

```ts
// Multiple columns — chain two groupBy calls
const byCategoryAndStatus = await Order.query()
  .select((o) => ({ category: o.category, status: o.status, cnt: count(o.id) }))
  .groupBy((o) => o.category)
  .groupBy((o) => o.status)
  .toArray();
```

```sql
SELECT category AS category, status AS status, COUNT(id) AS cnt
FROM orders
GROUP BY category, status
```

`.groupBy()` also accepts a column name string, an array of strings, or positional indices (`1`, `[1, 2]`) when chaining lambdas isn't convenient.

## HAVING

`.having()` accepts the same arrow-function syntax as `.where()`. Closure variables are auto-captured with the transformer:

```ts
// Only categories with more than 1 order
const busy = await Order.query()
  .select((o) => ({ category: o.category, cnt: count(o.id) }))
  .groupBy((o) => o.category)
  .having((o) => count(o.id) > 1)
  .toArray();
```

```sql
SELECT category AS category, COUNT(id) AS cnt
FROM orders
GROUP BY category
HAVING COUNT(id) > ?
-- params: [1]
```

```ts
// Closure variable
const minRevenue = 200;
const highRevenue = await Order.query()
  .select((o) => ({ category: o.category, revenue: sum(o.price) }))
  .groupBy((o) => o.category)
  .having((o) => sum(o.price) >= minRevenue)
  .toArray();
```

```sql
SELECT category AS category, SUM(price) AS revenue
FROM orders
GROUP BY category
HAVING SUM(price) >= ?
-- params: [200]
```

::: info Runtime mode
In runtime mode, pass closure variables explicitly: `.having((o) => sum(o.price) >= minRevenue, { minRevenue })`.
:::

## Expression Arguments

Aggregate arguments can be computed expressions. This is useful for totals derived from multiple columns and conditional counts:

```ts
const cutoff = 5;
const stats = await Order.query()
  .select(
    (o) => ({
      category: o.category,
      revenue: sum(o.price * o.qty),
      smallOrders: sum(o.qty < cutoff ? 1 : 0),
    }),
    { cutoff },
  )
  .groupBy((o) => o.category)
  .toArray();
```

```sql
SELECT category AS category,
       SUM(price * qty) AS revenue,
       SUM(CASE WHEN qty < ? THEN ? ELSE ? END) AS smallOrders
FROM orders
GROUP BY category
-- params: [5, 1, 0]
```

In runtime mode, pass closure variables used inside `.select()` as the second argument. With the transformer enabled, no second argument is needed.

## Combining WHERE + GROUP BY + HAVING

All three compose naturally:

```ts
const shippedStats = await Order.query()
  .where((o) => o.status === "shipped")
  .select((o) => ({ category: o.category, cnt: count(o.id), total: sum(o.price) }))
  .groupBy((o) => o.category)
  .having((o) => count(o.id) > 0)
  .orderBy((o) => o.category, "asc")
  .toArray();
```

```sql
SELECT category AS category, COUNT(id) AS cnt, SUM(price) AS total
FROM orders
WHERE status = ?
GROUP BY category
HAVING COUNT(id) > ?
ORDER BY category ASC
-- params: ["shipped", 0]
```

## DISTINCT

Wrap a column with `distinct()` inside another aggregate to deduplicate before aggregating:

```ts
// COUNT(DISTINCT category)
const uniqueCategories = await Order.query()
  .select((o) => ({ uniqueCategories: count(distinct(o.category)) }))
  .toArray();
```

```sql
SELECT COUNT(DISTINCT category) AS uniqueCategories FROM orders
```

```ts
// SUM(DISTINCT price)
const distinctRevenue = await Order.query()
  .select((o) => ({ revenue: sum(distinct(o.price)) }))
  .toArray();
```

```sql
SELECT SUM(DISTINCT price) AS revenue FROM orders
```

## Database-Specific Aggregates

### SQLite: `groupConcat`

```ts
import { groupConcat } from "typhex/sqlite";

// Per status
const byStatus = await Order.query()
  .select((o) => ({ status: o.status, categories: groupConcat(o.category, ", ") }))
  .groupBy((o) => o.status)
  .toArray();
```

```sql
SELECT status AS status, GROUP_CONCAT(category, ?) AS categories
FROM orders
GROUP BY status
-- params: [", "]
```

### PostgreSQL: `stringAgg`, `arrayAgg`, `jsonAgg`

```ts
import { stringAgg, arrayAgg, jsonAgg } from "typhex/postgres";

// STRING_AGG — concatenate with separator
const tagList = await Post.query()
  .select((p) => ({ category: p.category, tags: stringAgg(p.tag, ", ") }))
  .groupBy((p) => p.category)
  .toArray();
```

```sql
SELECT "category" AS "category", STRING_AGG("tag", $1) AS "tags"
FROM "posts"
GROUP BY "category"
-- params: [", "]
```

```ts
// ARRAY_AGG — collect values into a PostgreSQL array
const ids = await Post.query()
  .select((p) => ({ category: p.category, ids: arrayAgg(p.id) }))
  .groupBy((p) => p.category)
  .toArray();
// SQL: ARRAY_AGG("id") AS "ids"

// JSON_AGG — collect values into a JSON array
const titles = await Post.query()
  .select((p) => ({ category: p.category, titles: jsonAgg(p.title) }))
  .groupBy((p) => p.category)
  .toArray();
// SQL: JSON_AGG("title") AS "titles"
```
