/**
 * Subquery example: scalar SELECT, WHERE aggregate compare, and ORDER BY
 * subqueries — all transformer-only paths. The inner chain ends in
 * `.select(() => count())` to produce a single-row scalar; correlation
 * against the outer row happens via closure capture.
 *
 * Build and run: npm run subqueries  (from examples/)
 */

import { Db, Entity, createSqliteDriver, count } from "typhex";

const Author = Entity("authors", {
  id: "integer primary key autoincrement",
  name: "text not null",
});

const Post = Entity("posts", {
  id: "integer primary key autoincrement",
  authorId: "integer not null",
  title: "text not null",
  active: "integer not null",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

const alice = (await Author.query().insert({ name: "Alice" })) as { id: number };
const bob = (await Author.query().insert({ name: "Bob" })) as { id: number };
await Author.query().insert({ name: "Carol" });

await Post.query().insert({ authorId: alice.id, title: "A1", active: 1 });
await Post.query().insert({ authorId: alice.id, title: "A2", active: 1 });
await Post.query().insert({ authorId: alice.id, title: "A3", active: 0 });
await Post.query().insert({ authorId: bob.id, title: "B1", active: 1 });

// --- WHERE IN subquery (also works in runtime mode) ---

const activeAuthorsByIn = await Author.query()
  .where((a) =>
    a.id in Post.query().where((p) => p.active === 1).select((p) => p.authorId),
  )
  .orderBy("id", "asc")
  .toArray();
console.log("Authors with at least one active post:", activeAuthorsByIn);

// --- Scalar subquery in SELECT (correlated) ---

const authorsWithCounts = await Author.query()
  .select((a) => ({
    name: a.name,
    postCount: Post.query()
      .where((p) => p.authorId === a.id)
      .select(() => count()),
  }))
  .orderBy("id", "asc")
  .toArray();
console.log("Per-author post counts:", authorsWithCounts);

// --- Subquery aggregate in WHERE (correlated) ---

const prolificAuthors = await Author.query()
  .where(
    (a) =>
      Post.query()
        .where((p) => p.authorId === a.id)
        .select(() => count()) > 1,
  )
  .orderBy("id", "asc")
  .toArray();
console.log("Authors with more than 1 post:", prolificAuthors);

// --- Subquery in ORDER BY (correlated) ---

const sortedByPostCount = await Author.query()
  .orderBy(
    (a) =>
      Post.query()
        .where((p) => p.authorId === a.id)
        .select(() => count()),
    "desc",
  )
  .toArray();
console.log("Authors sorted by post count desc:", sortedByPostCount);

await db.close();
console.log("Done.");
