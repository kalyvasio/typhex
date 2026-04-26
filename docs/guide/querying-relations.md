# Querying Relations

Once you've [defined relations](/guide/entities-relations) on your entities, you can include related data in query results using a lambda passed to `.select()`.

## manyToOne in `select()`

When you select a `manyToOne` relation, Typhex fetches the related rows using a single `WHERE id IN (...)` query — not N+1 individual queries.

```ts
const Post = Entity(
  "posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    body: "text",
    authorId: "integer not null",
    published: "boolean",
  },
  { author: rel.manyToOne(() => User, { foreignKey: "authorId" }) },
);

const postsWithAuthor = await Post.query()
  .select((p) => ({ id: p.id, title: p.title, author: p.author })) // [!code highlight]
  .orderBy((p) => p.id, "asc")
  .toArray();
```

```sql
-- 1. Main query
SELECT id AS id, title AS title, authorId AS authorId FROM posts ORDER BY id ASC

-- 2. Author fetch (one query for all authors, regardless of how many posts)
SELECT id, name FROM users WHERE id IN (?, ?, ...)
```

## Partial Relation Select

Select only specific fields from the related entity by using an inline object literal:

```ts
const postsPartialAuthor = await Post.query()
  .select((p) => ({
    id: p.id,
    title: p.title,
    author: { id: p.author.id, name: p.author.name }, // [!code highlight]
  }))
  .toArray();
```

```sql
SELECT id AS id, title AS title, authorId AS authorId FROM posts
SELECT id, name FROM users WHERE id IN (?, ?, ...)  -- only id and name fetched
```

This keeps the result shape small when you don't need all columns from the related entity.

## oneToMany in `select()`

For `oneToMany` relations, call `.query()` on the relation to get a sub-query builder:

```ts
const User = Entity(
  "users",
  { id: "integer primary key autoincrement", name: "text not null", email: "text" },
  { posts: rel.oneToMany(() => Post, { foreignKey: "authorId" }) },
);

const usersWithPosts = await User.query()
  .select((u) => ({
    id: u.id,
    name: u.name,
    posts: u.posts.query().select((p) => ({ id: p.id, title: p.title })), // [!code highlight]
  }))
  .orderBy((p) => p.id, "asc")
  .toArray();
```

```sql
-- 1. Main query
SELECT id AS id, name AS name FROM users ORDER BY id ASC

-- 2. Posts fetched in one round-trip — all posts for all returned users
SELECT id AS id, title AS title, authorId AS authorId
FROM posts WHERE authorId IN (?, ?, ...)
```

Each user's `posts` field is populated in-memory by grouping the second result on `authorId`.

## Filtering + Relations Combined

Chain `.where()` before `.select()` — they compose naturally:

```ts
const publishedWithAuthor = await Post.query()
  .where((p) => p.published === true)
  .select((p) => ({ id: p.id, title: p.title, author: p.author }))
  .toArray();
```

```sql
SELECT id AS id, title AS title, authorId AS authorId
FROM posts WHERE published = ?
-- params: [1]

SELECT id, name FROM users WHERE id IN (?, ?, ...)  -- only authors of matching posts
```

::: tip No N+1 queries
Relation selects always use a single `WHERE foreignKey IN (...)` query to load all related rows in one round-trip — never per-row queries.
:::

## Circular References

The `() => Target` thunk in relation definitions handles lazy evaluation at query time, so circular relations work out of the box at runtime. When two entities reference each other across files, TypeScript needs help with the types — declare the relation property explicitly and use `createRequire` to break the import cycle:

```ts
// models/user.ts
import { createRequire } from "node:module";
import { Entity, rel, type OneToMany } from "typhex";
import type { Post } from "./post.js";

const _require = createRequire(import.meta.url);

export class User extends Entity(
  "users",
  { id: "integer primary key autoincrement", name: "text not null" },
  { posts: rel.oneToMany(() => _require("./post.js").Post, { foreignKey: "authorId" }) },
) {
  declare posts: OneToMany<Post>;
}
```

If your relations aren't circular, neither `declare` nor `createRequire` is needed — types flow directly from `rel.manyToOne(() => Company, ...)`.
