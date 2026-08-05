import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Db, Entity, rel } from "../../src";

const ToSqlUser = Entity("tosql_users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer not null",
  country: "text not null",
});

const ToSqlAuthor = Entity(
  "tosql_authors",
  {
    id: "integer primary key autoincrement",
    name: "text not null",
  },
  {
    posts: rel.oneToMany(() => ToSqlPost, { foreignKey: "authorId" }),
  },
);

const ToSqlPost = Entity(
  "tosql_posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    authorId: "integer not null",
  },
  {
    author: rel.manyToOne(() => ToSqlAuthor, { foreignKey: "authorId" }),
  },
);

const ToSqlTag = Entity("tosql_tags", {
  id: "integer primary key autoincrement",
  name: "text not null",
});

const ToSqlArticle = Entity(
  "tosql_articles",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
  },
  {
    tags: rel.manyToMany(() => ToSqlTag, {
      junction: "tosql_article_tags",
      foreignKey: "articleId",
      referenceKey: "tagId",
    }),
  },
);

describe("toSql", () => {
  let sqliteDb: Db;
  let postgresDb: Db;

  beforeAll(() => {
    vi.stubEnv("TYPHEX_COMPILE_ONLY", "1");
    sqliteDb = new Db({ dialect: "sqlite" });
    postgresDb = new Db({ dialect: "postgres" });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("compiles a SELECT with where/orderBy/limit without executing", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .where((u) => u.age > 18)
      .orderBy((u) => u.name, "asc")
      .limit(10)
      .toArray()
      .toSql();
    expect(sql).toMatch(/^SELECT /i);
    expect(sql).toContain("tosql_users");
    expect(sql).toMatch(/WHERE .*age.* > \?/i);
    expect(sql).toMatch(/ORDER BY/i);
    expect(sql).toMatch(/LIMIT/i);
    expect(params).toEqual([18, 10]);
  });

  it("binds closure params without executing", () => {
    const country = "US";
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .where((u) => u.country === country, { country })
      .toArray()
      .toSql();
    expect(sql).toMatch(/WHERE .*country.* = \?/i);
    expect(params).toEqual(["US"]);
  });

  it("compiles the SELECT behind first() with LIMIT 1", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .where((u) => u.age > 18)
      .first()
      .toSql();
    expect(sql).toMatch(/LIMIT/i);
    expect(params).toEqual([18, 1]);
  });

  it("compiles the COUNT behind count()", () => {
    const { sql } = ToSqlUser.query(sqliteDb)
      .where((u) => u.age > 18)
      .count()
      .toSql();
    expect(sql).toMatch(/COUNT/i);
  });

  it("compiles the DELETE behind delete()", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .where((u) => u.age > 18)
      .delete()
      .toSql();
    expect(sql).toMatch(/^DELETE FROM/i);
    expect(params).toEqual([18]);
  });

  it("compiles the UPDATE behind update()", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .where((u) => u.name === "Alice")
      .update({ age: 31 })
      .toSql();
    expect(sql).toMatch(/^UPDATE /i);
    expect(sql).toMatch(/SET .*age.* = \?/i);
    expect(params).toEqual([31, "Alice"]);
  });

  it("compiles UPDATE RETURNING behind updateReturning()", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .where((u) => u.name === "Alice")
      .updateReturning({ age: 31 })
      .toSql();
    expect(sql).toMatch(/^UPDATE /i);
    expect(sql).toMatch(/RETURNING/i);
    expect(params).toEqual([31, "Alice"]);
  });

  it("compiles DELETE RETURNING behind deleteReturning()", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .where((u) => u.name === "Alice")
      .deleteReturning()
      .toSql();
    expect(sql).toMatch(/^DELETE FROM/i);
    expect(sql).toMatch(/RETURNING/i);
    expect(params).toEqual(["Alice"]);
  });

  it("compiles findById() as a limited primary-key SELECT", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb).findById(7).toSql();
    expect(sql).toMatch(/^SELECT /i);
    expect(sql).toMatch(/WHERE .*id.* = \?/i);
    expect(sql).toMatch(/LIMIT/i);
    expect(params).toEqual([7, 1]);
  });

  it("compiles an INSERT from insert()", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .insert({ name: "Alice", age: 30, country: "US" })
      .toSql();
    expect(sql).toMatch(/^INSERT INTO/i);
    expect(params).toEqual(["Alice", 30, "US"]);
  });

  it("compiles an INSERT from insertMany()", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .insertMany([
        { name: "Alice", age: 30, country: "US" },
        { name: "Bob", age: 26, country: "UK" },
      ])
      .toSql();
    expect(sql).toMatch(/^INSERT INTO/i);
    expect(params).toEqual(["Alice", 30, "US", "Bob", 26, "UK"]);
  });

  it("compiles ON CONFLICT DO NOTHING behind doNothing()", () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .insert({ name: "Alice", age: 30, country: "US" })
      .onConflict(["name"])
      .doNothing()
      .toSql();
    expect(sql).toMatch(/^INSERT INTO/i);
    expect(sql).toMatch(/ON CONFLICT.*DO NOTHING/i);
    expect(params).toEqual(["Alice", 30, "US"]);
  });

  it("compiles ON CONFLICT DO UPDATE behind doUpdate() on insertMany()", () => {
    const { sql } = ToSqlUser.query(sqliteDb)
      .insertMany([
        { name: "Alice", age: 30, country: "US" },
        { name: "Bob", age: 26, country: "UK" },
      ])
      .onConflict(["name"])
      .doUpdate(["age"])
      .toSql();
    expect(sql).toMatch(/^INSERT INTO/i);
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
  });

  it("uses dialect-specific placeholders", () => {
    const query = () => ToSqlUser.query(postgresDb).where((u) => u.age > 18);
    expect(query().toArray().toSql().sql).toContain("$1");
    const sqlite = ToSqlUser.query(sqliteDb)
      .where((u) => u.age > 18)
      .toArray()
      .toSql();
    expect(sqlite.sql).toContain("?");
  });

  it("includes secondary WHERE IN SQL for eager-loaded relations", () => {
    const { sql, relationFetches } = ToSqlAuthor.query(sqliteDb)
      .select((a) => ({
        id: a.id,
        name: a.name,
        posts: a.posts,
      }))
      .toArray()
      .toSql();

    expect(sql).toMatch(/FROM ["']?tosql_authors/i);
    expect(relationFetches).toBeDefined();
    expect(relationFetches!.length).toBeGreaterThanOrEqual(1);
    const postsFetch = relationFetches!.find((f) => f.relation === "posts");
    expect(postsFetch).toBeDefined();
    expect(postsFetch!.sql).toMatch(/FROM ["']?tosql_posts/i);
    expect(postsFetch!.sql).toMatch(/IN\s*\(/i);
    expect(postsFetch!.params).toContain("«id»");
  });

  it("compiles many-to-many relation fetches without running migrate()", () => {
    const { relationFetches } = ToSqlArticle.query(sqliteDb)
      .select((a) => ({ id: a.id, title: a.title, tags: a.tags }))
      .toArray()
      .toSql();

    expect(relationFetches).toBeDefined();
    const junctionFetch = relationFetches!.find((f) => f.relation.includes("junction"));
    expect(junctionFetch).toBeDefined();
    expect(junctionFetch!.sql).toMatch(/FROM ["']?tosql_article_tags/i);
    const tagsFetch = relationFetches!.find((f) => f.relation === "tags");
    expect(tagsFetch).toBeDefined();
    expect(tagsFetch!.sql).toMatch(/FROM ["']?tosql_tags/i);
  });

  it("includes secondary WHERE IN SQL for many-to-one relation selects", () => {
    const { relationFetches } = ToSqlPost.query(sqliteDb)
      .select((p) => ({
        id: p.id,
        title: p.title,
        author: p.author,
      }))
      .toArray()
      .toSql();

    expect(relationFetches).toBeDefined();
    const authorFetch = relationFetches!.find((f) => f.relation === "author");
    expect(authorFetch).toBeDefined();
    expect(authorFetch!.sql).toMatch(/FROM ["']?tosql_authors/i);
    expect(authorFetch!.sql).toMatch(/IN\s*\(/i);
    expect(authorFetch!.params).toContain("«authorId»");
  });
});

describe("TYPHEX_COMPILE_ONLY", () => {
  beforeAll(() => {
    vi.stubEnv("TYPHEX_COMPILE_ONLY", "1");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to execute SQL", async () => {
    const db = new Db({ dialect: "sqlite" });
    await expect(db.query("SELECT 1")).rejects.toThrow("TYPHEX_COMPILE_ONLY");
    await expect(db.run("SELECT 1")).rejects.toThrow("TYPHEX_COMPILE_ONLY");
  });

  it("refuses to execute a built query", async () => {
    const db = new Db({ dialect: "sqlite" });
    await expect(ToSqlUser.query(db).toArray()).rejects.toThrow("TYPHEX_COMPILE_ONLY");
  });
});
