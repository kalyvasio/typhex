/**
 * Many-to-many: Post ↔ Tag via post_tags junction table.
 * The junction table is an ordinary SQL table — not an Entity.
 * Run: npx tsx examples/many-to-many/relation-queries.ts
 */

import { Db, createSqliteDriver } from "../../src/index.js";
import { Post, Tag } from "./models/index.js";

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

// The junction table is not managed by Entity/migrate — create it manually.
await db.run(
  "CREATE TABLE post_tags (postId INTEGER NOT NULL, tagId INTEGER NOT NULL)"
);

// Seed tags
const ts  = await Tag.query().insert({ name: "typescript" });
const orm = await Tag.query().insert({ name: "orm" });
const sql = await Tag.query().insert({ name: "sql" });

// Seed posts
const intro    = await Post.query().insert({ title: "Intro to TypeScript" });
const patterns = await Post.query().insert({ title: "ORM Design Patterns" });
const untagged = await Post.query().insert({ title: "Untagged Draft" });

// Wire up junction rows
await db.run("INSERT INTO post_tags VALUES (?, ?)", [intro.id,    ts.id]);
await db.run("INSERT INTO post_tags VALUES (?, ?)", [intro.id,    orm.id]);
await db.run("INSERT INTO post_tags VALUES (?, ?)", [patterns.id, orm.id]);
await db.run("INSERT INTO post_tags VALUES (?, ?)", [patterns.id, sql.id]);
// untagged has no junction rows

console.log("\n=== select with many-to-many relation ===");
const posts = await Post.query()
  .select((p) => ({
    id: p.id,
    title: p.title,
    tags: p.tags.query().select((t) => ({ name: t.name })).orderBy("name", "asc"),
  }))
  .orderBy("id", "asc")
  .toArray();

for (const p of posts) {
  const tagNames = p.tags.map((t) => t.name).join(", ") || "(none)";
  console.log(`  Post ${p.id} "${p.title}": [${tagNames}]`);
}

console.log("\n=== fetch single post with tags ===");
const found = await Post.query()
  .select((p) => ({ id: p.id, title: p.title, tags: p.tags }))
  .where((p) => p.title === "Intro to TypeScript", { "Intro to TypeScript": "Intro to TypeScript" })
  .first();

console.log(`  "${found?.title}" has ${found?.tags.length} tag(s)`);

await db.close();
console.log("\nDone.");
