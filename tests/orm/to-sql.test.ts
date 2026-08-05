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
      .toSql();
    expect(sql).toMatch(/WHERE .*country.* = \?/i);
    expect(params).toEqual(["US"]);
  });

  it('compiles the COUNT statement with kind "count"', () => {
    const { sql } = ToSqlUser.query(sqliteDb)
      .where((u) => u.age > 18)
      .toSql("count");
    expect(sql).toMatch(/COUNT/i);
  });

  it('compiles the DELETE statement with kind "delete"', () => {
    const { sql, params } = ToSqlUser.query(sqliteDb)
      .where((u) => u.age > 18)
      .toSql("delete");
    expect(sql).toMatch(/^DELETE FROM/i);
    expect(params).toEqual([18]);
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

  it("uses dialect-specific placeholders", () => {
    const query = () => ToSqlUser.query(postgresDb).where((u) => u.age > 18);
    expect(query().toSql().sql).toContain("$1");
    const sqlite = ToSqlUser.query(sqliteDb)
      .where((u) => u.age > 18)
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

  it("includes secondary WHERE IN SQL for many-to-one relation selects", () => {
    const { relationFetches } = ToSqlPost.query(sqliteDb)
      .select((p) => ({
        id: p.id,
        title: p.title,
        author: p.author,
      }))
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
