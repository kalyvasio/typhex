/**
 * Query-builder scopes example.
 *
 * Demonstrates two patterns for attaching named scopes to an entity's query
 * builder, then shows top-level scope usage and chaining.
 *
 * Run: npx tsx examples/query-builder-scopes.ts  (from the project root)
 */

import { Db, Entity, createSqliteDriver, QueryBuilder } from "../src/index.js";
import type { EntityInstance } from "../src/index.js";
import { clearRegistry, registerEntity } from "../src/entity/global-driver.js";

// ============================================================
// Pattern A — BaseEntity split (no `declare`, no forward refs)
// ============================================================
// Define the entity base via Entity(), then subclass both the
// QueryBuilder and the entity class.  Works without circular
// references and without TypeScript's `declare` keyword.

const BasePost = Entity("posts", {
  id: "integer primary key autoincrement",
  title: "text not null",
  archived: "integer not null default 0",
});

class PostQuery extends QueryBuilder<typeof BasePost, EntityInstance<typeof BasePost>> {
  /** Return only archived posts. */
  archived(): this {
    return this.where((p: any) => p.archived == 1);
  }

  /** Return only live (non-archived) posts. */
  live(): this {
    return this.where((p: any) => p.archived == 0);
  }
}

class Post extends BasePost {
  static queryBuilder = PostQuery;
}

// ============================================================
// Pattern B — Single class with `declare` + late assignment
// ============================================================
// Keep everything in one class; use `declare static queryBuilder`
// so TypeScript knows the narrowed type, then assign after both
// classes are defined.

class Article extends Entity("articles", {
  id: "integer primary key autoincrement",
  title: "text not null",
  published: "integer not null default 0",
}) {
  declare static queryBuilder: typeof ArticleQuery;
}

class ArticleQuery extends QueryBuilder<typeof Article, EntityInstance<typeof Article>> {
  /** Return only published articles. */
  published(): this {
    return this.where((a: any) => a.published == 1);
  }
}

Article.queryBuilder = ArticleQuery;

// ============================================================
// Main: seed data and demonstrate scope usage
// ============================================================

clearRegistry();
registerEntity(Post as any);
registerEntity(Article as any);

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

// Seed posts
await Post.query().insert({ title: "Hello World",        archived: 0 });
await Post.query().insert({ title: "How TypeScript Helps", archived: 0 });
await Post.query().insert({ title: "Old News",           archived: 1 });
await Post.query().insert({ title: "Another Old Post",   archived: 1 });

// Top-level scope: fetch all archived posts
const archivedPosts = await Post.query().archived().toArray();
console.log("Archived posts:", archivedPosts.map((p: any) => p.title));
// → ["Old News", "Another Old Post"]

// Chaining: archived + title filter + ordering
const filteredPosts = await Post.query()
  .archived()
  .where((p: any) => p.title.startsWith("A"))
  .orderBy((p: any) => p.title)
  .toArray();
console.log("Archived, title starts with 'A':", filteredPosts.map((p: any) => p.title));
// → ["Another Old Post"]

// Pattern B in action
await Article.query().insert({ title: "Draft",     published: 0 });
await Article.query().insert({ title: "Published", published: 1 });

const publishedArticles = await Article.query().published().toArray();
console.log("Published articles:", publishedArticles.map((a: any) => a.title));
// → ["Published"]

await db.close();

// ============================================================
// Note on relation callbacks
// ============================================================
// When a scope is used inside a select() relation callback, e.g.:
//
//   Post.query().select(p => ({ id: p.id, comments: p.comments.archived() }))
//
// The TypeScript transformer (typhex/transformer) inlines the scope's
// where-predicate into the IrSelect at compile time so no runtime
// function call is needed.  Without the transformer you can pass a
// pre-built IrSelect directly:
//
//   Post.query().select({
//     param: "p",
//     paths: [["id"]],
//     aliases: ["id"],
//     relations: [{
//       name: "comments",
//       outputKey: "comments",
//       whereIr: { kind: "binary", op: "==",
//                  left: { kind: "member", param: "c", path: ["archived"] },
//                  right: { kind: "const", value: 1 } }
//     }]
//   })
