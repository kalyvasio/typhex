/**
 * Circular refs: User ↔ Post ↔ Comment with declare and createRequire.
 * Run: npx tsx examples/circular-refs/relation-queries.ts
 */

import { Db, createSqliteDriver } from "../../src/index.js";
import { Post, User } from "./models/index.js";

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
const bob = await User.query().insert({ name: "Bob", email: "bob@example.com" });
await Post.query().insert({
  title: "First post",
  body: "Hello world.",
  authorId: alice.id,
  published: true,
});
await Post.query().insert({
  title: "Draft",
  body: "Work in progress...",
  authorId: bob.id,
  published: false,
});
await Post.query().insert({
  title: "Alice's second",
  body: "Another one.",
  authorId: alice.id,
  published: true,
});

console.log("=== manyToOne: posts with author ===");
const postsWithAuthor = await Post.query()
  .select((p) => ({ id: p.id, title: p.title, author: p.author }))
  .orderBy("id", "asc")
  .toArray();
for (const p of postsWithAuthor) {
  console.log(`  Post ${p.id} "${p.title}" by ${p.author?.name ?? "null"}`);
}

console.log("\n=== Partial relation select: author id and name only ===");
const postsPartialAuthor = await Post.query()
  .select((p) => ({
    id: p.id,
    title: p.title,
    author: { id: p.author.id, name: p.author.name },
  }))
  .toArray();
console.log("  Sample:", JSON.stringify(postsPartialAuthor[0], null, 2));

console.log("\n=== oneToMany: users with their posts ===");
const usersWithPosts = await User.query()
  .select((u) => ({
    id: u.id,
    name: u.name,
    posts: u.posts.query().select((p) => ({ id: p.id, title: p.title })),
  }))
  .orderBy("id", "asc")
  .toArray();
for (const u of usersWithPosts) {
  const titles = u.posts.map((p) => p.title).join(", ");
  console.log(`  User ${u.id} "${u.name}": [${titles}]`);
}

console.log("\n=== Filtered query with relations ===");
const publishedWithAuthor = await Post.query()
  .where((p) => p.published === true)
  .select((p) => ({ id: p.id, title: p.title, author: p.author }))
  .toArray();
console.log(`  Published posts: ${publishedWithAuthor.length}`);

await db.close();
console.log("\nDone.");
