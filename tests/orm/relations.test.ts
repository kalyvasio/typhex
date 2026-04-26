import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Entity, rel, Db, createSqliteDriver } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";

const User = Entity(
  "users",
  {
    id: "integer primary key autoincrement",
    name: "text not null",
    email: "text",
  },
  {
    posts: rel.oneToMany(() => Post, { foreignKey: "authorId" }),
  },
);

const Post = Entity(
  "posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    body: "text",
    authorId: "integer not null",
    published: "boolean",
  },
  {
    author: rel.manyToOne(() => User, { foreignKey: "authorId" }),
  },
);

describe("relation loading", () => {
  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(User);
    registerEntity(Post);
    db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.migrate();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("manyToOne - select with relation", () => {
    it("loads author when selecting (p) => ({ id: p.id, title: p.title, author: p.author })", async () => {
      const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
      await Post.query().insert({
        title: "First",
        body: "Hello",
        authorId: (alice as any).id,
        published: true,
      });

      const results = await Post.query()
        .select((p: any) => ({ id: p.id, title: p.title, author: p.author }))
        .toArray();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: 1,
        title: "First",
        authorId: 1,
      });
      expect(results[0].author).toMatchObject({
        id: 1,
        name: "Alice",
        email: "alice@example.com",
      });
    });

    it("loads author with partial select (p) => ({ id: p.id, author: { id: p.author.id, name: p.author.name } })", async () => {
      const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
      await Post.query().insert({
        title: "First",
        body: "Hello",
        authorId: (alice as any).id,
        published: true,
      });

      const results = await Post.query()
        .select((p: any) => ({
          id: p.id,
          author: { id: p.author.id, name: p.author.name },
        }))
        .toArray();

      expect(results).toHaveLength(1);
      expect(results[0].author).toMatchObject({ id: 1, name: "Alice" });
      expect(results[0].author).not.toHaveProperty("email");
    });

    it("batches author loading for multiple posts", async () => {
      const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
      const bob = await User.query().insert({ name: "Bob", email: "bob@example.com" });
      await Post.query().insert({
        title: "P1",
        body: "x",
        authorId: (alice as any).id,
        published: true,
      });
      await Post.query().insert({
        title: "P2",
        body: "y",
        authorId: (bob as any).id,
        published: true,
      });
      await Post.query().insert({
        title: "P3",
        body: "z",
        authorId: (alice as any).id,
        published: true,
      });

      const results = await Post.query()
        .select((p: any) => ({ id: p.id, title: p.title, author: p.author }))
        .orderBy("id", "asc")
        .toArray();

      expect(results).toHaveLength(3);
      expect(results[0].author?.name).toBe("Alice");
      expect(results[1].author?.name).toBe("Bob");
      expect(results[2].author?.name).toBe("Alice");
    });
  });

  describe("oneToMany - select with relation", () => {
    it("loads posts when selecting (u) => ({ id: u.id, name: u.name, posts: u.posts })", async () => {
      const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
      await Post.query().insert({
        title: "P1",
        body: "x",
        authorId: (alice as any).id,
        published: true,
      });
      await Post.query().insert({
        title: "P2",
        body: "y",
        authorId: (alice as any).id,
        published: true,
      });

      const results = await User.query()
        .select((u: any) => ({ id: u.id, name: u.name, posts: u.posts }))
        .toArray();

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(2);
      expect(results[0].posts.map((p: any) => p.title).sort()).toEqual(["P1", "P2"]);
    });

    it("loads empty array when user has no posts", async () => {
      await User.query().insert({ name: "Carol", email: "carol@example.com" });

      const results = await User.query()
        .select((u: any) => ({ id: u.id, name: u.name, posts: u.posts }))
        .where((u: any) => u.name === "Carol")
        .toArray();

      expect(results).toHaveLength(1);
      expect(results[0].posts).toEqual([]);
    });

    it("loads posts with query chain: where, orderBy, select", async () => {
      const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
      await Post.query().insert({
        title: "B-post",
        body: "x",
        authorId: (alice as any).id,
        published: false,
      });
      await Post.query().insert({
        title: "A-post",
        body: "y",
        authorId: (alice as any).id,
        published: true,
      });
      await Post.query().insert({
        title: "C-post",
        body: "z",
        authorId: (alice as any).id,
        published: true,
      });

      const results = await User.query()
        .select((u: any) => ({
          id: u.id,
          posts: u.posts
            .query()
            .where((p: any) => p.published === true)
            .orderBy("title", "asc")
            .select((p: any) => ({ id: p.id, title: p.title })),
        }))
        .where((u: any) => u.name === "Alice")
        .toArray();

      expect(results).toHaveLength(1);
      expect(results[0].posts).toHaveLength(2);
      expect(results[0].posts[0].title).toBe("A-post");
      expect(results[0].posts[1].title).toBe("C-post");
      expect(results[0].posts[0]).not.toHaveProperty("body");
    });
  });
});
