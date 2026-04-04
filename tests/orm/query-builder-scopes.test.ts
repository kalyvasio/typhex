import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db } from "../../src/orm/db.js";
import { Entity } from "../../src/entity/entity.js";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import type { ScopedQueryBuilder } from "../../src/orm/query-builder.js";
import type { EntityInstance } from "../../src/entity/entity.js";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";

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
