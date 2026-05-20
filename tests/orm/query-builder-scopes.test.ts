import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db } from "../../src/orm/db.js";
import { Entity } from "../../src/entity/entity.js";
import { rel } from "../../src/entity/relations.js";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import type { ScopedQueryBuilder } from "../../src/orm/query-builder.js";
import type { EntityInstance } from "../../src/entity/entity.js";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import type { IrSelect } from "../../src/ir/types.js";

// --- Pattern A: BasePost split (no `declare`, no forward refs) ---

const BasePost = Entity("scope_posts", {
  id: "integer primary key autoincrement",
  title: "text not null",
  archived: "integer not null default 0",
});

class PostQuery extends QueryBuilder<typeof BasePost, EntityInstance<typeof BasePost>> {
  archived(): this {
    return this.where((p: any) => p.archived == 1);
  }
}

class Post extends BasePost {
  static queryBuilder = PostQuery;
}

// --- Pattern B: Single class with `declare` + late assignment ---

class PostB extends Entity("scope_posts_b", {
  id: "integer primary key autoincrement",
  title: "text not null",
  archived: "integer not null default 0",
}) {
  declare static queryBuilder: typeof PostBQuery;
}

class PostBQuery extends QueryBuilder<typeof PostB, EntityInstance<typeof PostB>> {
  published(): this {
    return this.where((p: any) => p.archived == 0);
  }
}

PostB.queryBuilder = PostBQuery;

// --- Pattern C: No scopes (default, unchanged) ---

const Plain = Entity("scope_plain", {
  id: "integer primary key autoincrement",
  name: "text not null",
});

describe("QueryBuilder scopes", () => {
  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(Post as any);
    registerEntity(PostB as any);
    registerEntity(Plain);
    db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.migrate();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Pattern A (BasePost split)", () => {
    it("Post.query() returns an instance of PostQuery", () => {
      expect(Post.query()).toBeInstanceOf(PostQuery);
    });

    it("Post.query() is also an instance of QueryBuilder", () => {
      expect(Post.query()).toBeInstanceOf(QueryBuilder);
    });

    it("Post.query().archived() returns a PostQuery instance (scope chaining)", () => {
      expect(Post.query().archived()).toBeInstanceOf(PostQuery);
    });

    it("Post.query().clone() returns a PostQuery instance (clone preserves subclass)", () => {
      expect(Post.query().clone()).toBeInstanceOf(PostQuery);
    });

    it("Post.query().archived().where(...) still works (base methods still available)", () => {
      const q = Post.query().archived().where((p: any) => p.title == "hello");
      expect(q).toBeInstanceOf(PostQuery);
    });

    it("Post.query().archived().limit(10) chains and returns PostQuery", () => {
      expect(Post.query().archived().limit(10)).toBeInstanceOf(PostQuery);
    });

    it("Post.query().archived().offset(5) chains and returns PostQuery", () => {
      expect(Post.query().archived().offset(5)).toBeInstanceOf(PostQuery);
    });

    it("Post.query().orderBy('title') returns PostQuery", () => {
      expect(Post.query().orderBy("title")).toBeInstanceOf(PostQuery);
    });

    it("executes archived() scope and returns only archived rows", async () => {
      await Post.query().insert({ title: "Active", archived: 0 });
      await Post.query().insert({ title: "Archived", archived: 1 });

      const results = await Post.query().archived().toArray();
      expect(results).toHaveLength(1);
      expect((results[0] as any).title).toBe("Archived");
    });
  });

  describe("Pattern B (declare + late assignment)", () => {
    it("PostB.query() returns an instance of PostBQuery", () => {
      expect(PostB.query()).toBeInstanceOf(PostBQuery);
    });

    it("PostB.query().published() returns a PostBQuery instance (scope chaining)", () => {
      expect(PostB.query().published()).toBeInstanceOf(PostBQuery);
    });

    it("PostB.query().clone() returns a PostBQuery instance (clone preserves subclass)", () => {
      expect(PostB.query().clone()).toBeInstanceOf(PostBQuery);
    });

    it("executes published() scope and returns only non-archived rows", async () => {
      await PostB.query().insert({ title: "Draft", archived: 1 });
      await PostB.query().insert({ title: "Live", archived: 0 });

      const results = await PostB.query().published().toArray();
      expect(results).toHaveLength(1);
      expect((results[0] as any).title).toBe("Live");
    });
  });

  describe("Pattern C (no scopes — default, unchanged)", () => {
    it("Plain.query() returns a plain QueryBuilder", () => {
      expect(Plain.query()).toBeInstanceOf(QueryBuilder);
    });

    it("Plain.query() is NOT an instance of PostQuery", () => {
      expect(Plain.query()).not.toBeInstanceOf(PostQuery);
    });

    it("Plain.query().clone() returns a plain QueryBuilder", () => {
      expect(Plain.query().clone()).toBeInstanceOf(QueryBuilder);
      expect(Plain.query().clone()).not.toBeInstanceOf(PostQuery);
    });

    it("Plain.query() works normally for insert/toArray", async () => {
      await Plain.query().insert({ name: "Alice" });
      const results = await Plain.query().toArray();
      expect(results).toHaveLength(1);
      expect((results[0] as any).name).toBe("Alice");
    });
  });
});

// ---------------------------------------------------------------------------
// IrSelect with relations.whereIr — end-to-end integration
// ---------------------------------------------------------------------------

// Entity definitions for the relations.whereIr integration tests.
// Use unique table names to avoid collisions with other test suites.
const ScopeComment = Entity("scope_comments", {
  id: "integer primary key autoincrement",
  body: "text not null",
  post_id: "integer not null",
  archived: "integer not null default 0",
});

const ScopePost = Entity(
  "scope_posts_rel",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
  },
  {
    comments: rel.oneToMany(() => ScopeComment, { foreignKey: "post_id" }),
  }
);

describe("IrSelect with relations.whereIr (end-to-end)", () => {
  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(ScopePost as any);
    registerEntity(ScopeComment);
    db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.migrate();
  });

  afterEach(async () => {
    await db.close();
  });

  it("filters relation rows via whereIr when passing a pre-built IrSelect", async () => {
    // Insert two posts, each with an archived and a non-archived comment.
    const postA = await ScopePost.query().insert({ title: "Post A" });
    const postB = await ScopePost.query().insert({ title: "Post B" });

    await ScopeComment.query().insert({ body: "Archived A1", post_id: (postA as any).id, archived: 1 });
    await ScopeComment.query().insert({ body: "Live A1",     post_id: (postA as any).id, archived: 0 });
    await ScopeComment.query().insert({ body: "Archived B1", post_id: (postB as any).id, archived: 1 });
    await ScopeComment.query().insert({ body: "Live B1",     post_id: (postB as any).id, archived: 0 });

    // Simulate what the transformer would produce for:
    //   ScopePost.query().select(p => ({ id: p.id, comments: p.comments.archived() }))
    // where archived() is defined as this.where(c => c.archived == 1).
    const irSelect: IrSelect = {
      param: "p",
      paths: [["id"]],
      aliases: ["id"],
      relations: [
        {
          name: "comments",
          outputKey: "comments",
          whereIr: {
            node: {
              kind: "binary",
              op: "==",
              left: { kind: "member", param: "c", path: ["archived"] },
              right: { kind: "const", value: 1 },
            },
            rootParam: "c",
            localParamNames: ["c"],
          },
        },
      ],
    };

    const results = await ScopePost.query().select(irSelect).toArray();

    expect(results).toHaveLength(2);

    // Sort by id for deterministic assertion order
    const sorted = [...results].sort((a: any, b: any) => a.id - b.id);

    const commentsA = (sorted[0] as any).comments as any[];
    expect(commentsA).toBeDefined();
    expect(commentsA).toHaveLength(1);
    expect(commentsA[0].body).toBe("Archived A1");
    expect(commentsA[0].archived).toBe(1);

    const commentsB = (sorted[1] as any).comments as any[];
    expect(commentsB).toBeDefined();
    expect(commentsB).toHaveLength(1);
    expect(commentsB[0].body).toBe("Archived B1");
    expect(commentsB[0].archived).toBe(1);
  });

  it("returns all relation rows when whereIr is absent", async () => {
    const post = await ScopePost.query().insert({ title: "Post C" });
    await ScopeComment.query().insert({ body: "Archived", post_id: (post as any).id, archived: 1 });
    await ScopeComment.query().insert({ body: "Live",     post_id: (post as any).id, archived: 0 });

    const irSelect: IrSelect = {
      param: "p",
      paths: [["id"]],
      aliases: ["id"],
      relations: [{ name: "comments", outputKey: "comments" }],
    };

    const results = await ScopePost.query().select(irSelect).toArray();
    expect(results).toHaveLength(1);

    const comments = (results[0] as any).comments as any[];
    expect(comments).toHaveLength(2);
  });
});
