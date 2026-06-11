# Expressions in Queries

Typhex accepts a practical expression subset anywhere a query lambda expects a value: `where()`, `having()`, `select()`, aggregate arguments, and `orderBy()`.

## Conditional and Arithmetic Expressions

Use JavaScript ternaries for SQL `CASE` expressions, and arithmetic operators for derived values:

```ts
const lineItems = await Order.query()
  .select((o) => ({
    id: o.id,
    revenue: o.price * o.qty,
    bucket: o.qty < 5 ? "small" : "large",
  }))
  .orderBy((o) => (o.qty < 5 ? 1 : 0))
  .toArray();
```

```sql
SELECT id AS id,
       (price * qty) AS revenue,
       CASE WHEN qty < ? THEN ? ELSE ? END AS bucket
FROM orders
ORDER BY CASE WHEN qty < ? THEN ? ELSE ? END ASC
```

Supported arithmetic operators are `+`, `-`, `*`, `/`, and `%`. Bitwise operators `&`, `|`, `^`, `<<`, `>>`, and unary `~` are also supported; PostgreSQL emits `#` for XOR.

## Null Checks

Strict null comparisons compile to SQL null semantics:

```ts
const liveCount = await Order.query()
  .where((o) => o.deletedAt === null)
  .count();

const deletedCount = await Order.query()
  .where((o) => o.deletedAt !== null)
  .count();
```

```sql
WHERE deletedAt IS NULL
WHERE deletedAt IS NOT NULL
```

## Computed Select Columns

Projection fields can be expressions, not just direct columns:

```ts
const prices = await Order.query()
  .select((o) => ({
    id: o.id,
    cents: o.price * 100,
    activeLabel: o.active ? "active" : "inactive",
  }))
  .toArray();
```

If the lambda returns a single scalar expression, Typhex aliases it as `expr`:

```ts
const cents = await Order.query()
  .select((o) => o.price * 100)
  .toArray();
```

## Expressions Inside Aggregates

Aggregate arguments can include ternaries and arithmetic, which is useful for conditional counts and revenue totals:

```ts
import { sum } from "typhex";

const cutoff = 5;
const buckets = await Order.query()
  .select(
    (o) => ({
      category: o.category,
      revenue: sum(o.price * o.qty),
      smalls: sum(o.qty < cutoff ? 1 : 0),
    }),
    { cutoff },
  )
  .groupBy("category")
  .toArray();
```

In runtime mode, pass closure variables used by `.select()` as the second argument. With the TypeScript transformer, those variables are captured automatically.

## Runtime and Transformer Boundaries

Ternaries, arithmetic, bitwise operators, null checks, computed projections, and expression `orderBy()` work in runtime mode and transformer mode.

Scalar correlated subqueries in `.select()`, comparison `.where()` predicates, and `.orderBy()` are transformer-only. See [Subqueries](/guide/subqueries) for those shapes.
