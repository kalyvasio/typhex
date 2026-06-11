# Subqueries

Typhex supports `IN` subqueries in runtime mode and transformer mode. Scalar and correlated subqueries are transformer-only because the compiler needs to capture the outer query reference.

## `IN` Subqueries

In runtime mode, build the inner query first and pass it through the params object:

```ts
const activePostAuthors = Post.query()
  .where((p) => p.active === 1)
  .select((p) => p.authorId);

const authors = await Author.query()
  .where((a, posts) => a.id in posts, { posts: activePostAuthors })
  .toArray();
```

```sql
SELECT "t0"."id", "t0"."name"
FROM "authors" AS "t0"
WHERE "t0"."id" IN (
  SELECT "t1"."authorId" FROM "posts" AS "t1" WHERE ("t1"."active" = ?)
)
-- params: [1]
```

With the transformer enabled, the inner query can be written inline:

```ts
const authors = await Author.query()
  .where(
    (a) =>
      a.id in
      Post.query()
        .where((p) => p.active === 1)
        .select((p) => p.authorId),
  )
  .toArray();
```

```sql
SELECT "t0"."id", "t0"."name"
FROM "authors" AS "t0"
WHERE "t0"."id" IN (
  SELECT "t1"."authorId" FROM "posts" AS "t1" WHERE ("t1"."active" = ?)
)
-- params: [1]
```

Nested inline `IN` subqueries use the same transformer path:

```ts
const authors = await Author.query()
  .where(
    (a) =>
      a.id in
      Post.query()
        .where(
          (p) =>
            p.authorId in
            Author.query()
              .where((candidate) => candidate.name !== "Carol")
              .select((candidate) => candidate.id),
        )
        .select((p) => p.authorId),
  )
  .toArray();
```

```sql
SELECT "t0"."id", "t0"."name"
FROM "authors" AS "t0"
WHERE "t0"."id" IN (
  SELECT "t1"."authorId" FROM "posts" AS "t1"
  WHERE "t1"."authorId" IN (
    SELECT "t2"."id" FROM "authors" AS "t2" WHERE ("t2"."name" <> ?)
  )
)
-- params: ["Carol"]
```

## Scalar Subqueries

Use `.select(() => count())` on the inner query when the subquery should return one value:

```ts
import { count } from "typhex";

const authorsWithCounts = await Author.query()
  .select((a) => ({
    name: a.name,
    postCount: Post.query()
      .where((p) => p.authorId === a.id)
      .select(() => count()),
  }))
  .toArray();
```

```sql
SELECT "t0"."name" AS "name",
       (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) AS "postCount"
FROM "authors" AS "t0"
```

The `a.id` reference is correlated to the outer row, so this form requires the TypeScript transformer.

## Comparing Against Subqueries

Scalar subqueries can appear in `where()` comparisons:

```ts
const prolificAuthors = await Author.query()
  .where(
    (a) =>
      Post.query()
        .where((p) => p.authorId === a.id)
        .select(() => count()) > 1,
  )
  .toArray();
```

```sql
SELECT "t0"."id", "t0"."name"
FROM "authors" AS "t0"
WHERE ((SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) > ?)
-- params: [1]
```

## Ordering by Subqueries

Correlated scalar subqueries also work in `orderBy()`:

```ts
const sorted = await Author.query()
  .orderBy(
    (a) =>
      Post.query()
        .where((p) => p.authorId === a.id)
        .select(() => count()),
    "desc",
  )
  .toArray();
```

```sql
SELECT "t0"."id", "t0"."name"
FROM "authors" AS "t0"
ORDER BY (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) DESC
```

Run `npm run subqueries` from `examples/` for a complete transformer-backed demo.
