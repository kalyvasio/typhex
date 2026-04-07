import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db, Entity, rel, createSqliteDriver } from "../../src/index.js";
import { sqliteDialect } from "../../src/dbs/sqlite/dialect.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { whereColumnEq } from "../../src/orm/query-helpers.js";

const User = Entity(
  "insert_graph_users",
  {
    id: "integer primary key autoincrement",
    name: "text not null",
  },
  {
    posts: rel.oneToMany(() => Post, { foreignKey: "authorId" }),
  },
);

const Tag = Entity(
  "insert_graph_tags",
  {
    id: "integer primary key autoincrement",
    name: "text not null",
  },
);

const Post = Entity(
  "insert_graph_posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    authorId: "integer not null",
  },
  {
    author: rel.manyToOne(() => User, { foreignKey: "authorId" }),
    tags: rel.manyToMany(() => Tag, {
      junction: "insert_graph_post_tags",
      foreignKey: "postId",
      referenceKey: "tagId",
    }),
  },
);

describe("insertGraph", () => {
  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(User);
    registerEntity(Post);
    registerEntity(Tag);
    db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.migrate();
  });

  afterEach(async () => {
    await db.close();
  });

  it("inserts many-to-one parents before the root row", async () => {
    const post = await Post.query().insertGraph({
      title: "Hello",
      author: { name: "Alice" },
    });

    expect(post.authorId).toBe(1);

    const author = await User.query().findById(1);
    expect(author).not.toBeNull();
    expect(author?.name).toBe("Alice");
  });

  it("inserts one-to-many children after inserting the root row", async () => {
    const user = await User.query().insertGraph({
      name: "Alice",
      posts: [{ title: "First" }, { title: "Second" }],
    });

    const posts = await Post.query()
      .where(whereColumnEq("authorId", (user as { id: number }).id))
      .orderBy("title", "asc")
      .toArray();

    expect(posts).toHaveLength(2);
    expect(posts.map((post) => post.title)).toEqual(["First", "Second"]);
    expect(posts.every((post) => post.authorId === user.id)).toBe(true);
  });

  it("creates new many-to-many targets and connects existing ones", async () => {
    const existingTag = await Tag.query().insert({ name: "existing" });

    const post = await Post.query().insertGraph({
      title: "Hello",
      author: { name: "Alice" },
      tags: [{ id: existingTag.id }, { name: "new" }],
    });

    const rawJunctionRows = await db.query(
      'SELECT "postId", "tagId" FROM "insert_graph_post_tags" ORDER BY "tagId"',
    ) as Array<{ postId: number; tagId: number }>;
    expect(rawJunctionRows).toEqual([
      { postId: post.id, tagId: existingTag.id },
      { postId: post.id, tagId: 2 },
    ]);

    const loaded = await Post.query()
      .where(whereColumnEq("id", (post as { id: number }).id))
      .select((p: any) => ({ id: p.id, tags: p.tags.query().orderBy("name", "asc") }))
      .first() as { id: number; tags: Array<{ id: number; name: string }> } | undefined;

    expect(loaded?.tags.map((tag) => tag.name)).toEqual(["existing", "new"]);
  });

  it("accepts an array of roots and returns them in input order", async () => {
    const users = await User.query().insertGraph([
      { name: "Alice", posts: [{ title: "A-1" }, { title: "A-2" }] },
      { name: "Bob", posts: [{ title: "B-1" }] },
    ]);

    expect(users.map((user) => user.name)).toEqual(["Alice", "Bob"]);

    const posts = await Post.query()
      .orderBy("title", "asc")
      .toArray();

    expect(posts.map((post) => post.title)).toEqual(["A-1", "A-2", "B-1"]);
    expect(posts.map((post) => post.authorId)).toEqual([users[0].id, users[0].id, users[1].id]);
  });

  it("reuses an explicit transaction and rolls back on failure", async () => {
    await expect(
      db.transaction(async (trx) => {
        await User.query(trx).insertGraph([
          { name: "Alice", posts: [{ title: "A-1" }] },
          { name: "Bob", posts: [{}] },
        ]);
      }),
    ).rejects.toThrow();

    expect(await User.query().count()).toBe(0);
    expect(await Post.query().count()).toBe(0);
  });

  it("falls back to sequential graph inserts when batch ID resolution is disabled", async () => {
    const original = sqliteDialect.insertCapabilities.supportsReturning;
    (sqliteDialect.insertCapabilities as { supportsReturning: boolean }).supportsReturning = false;

    try {
      const users = await User.query().insertGraph([
        { name: "Alice", posts: [{ title: "A-1" }] },
        { name: "Bob", posts: [{ title: "B-1" }] },
      ]);

      expect(users.map((user) => user.name)).toEqual(["Alice", "Bob"]);

      const posts = await Post.query()
        .orderBy("title", "asc")
        .toArray();

      expect(posts.map((post) => post.title)).toEqual(["A-1", "B-1"]);
    } finally {
      (sqliteDialect.insertCapabilities as { supportsReturning: boolean }).supportsReturning = original;
    }
  });
});
