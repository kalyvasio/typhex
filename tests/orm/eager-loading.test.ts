import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Entity, rel, Db, createSqliteDriver } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import type { QueryExecutor } from "../../src/orm/db.js";
import type { RelationDef } from "../../src/entity/relations.js";

const User = Entity(
  "users",
  {
    id: "integer primary key autoincrement",
    name: "text not null",
  }
);

const Post = Entity(
  "posts",
  {
    id: "integer primary key autoincrement",
    title: "text not null",
    authorId: "integer",
  },
  {
    author: rel.manyToOne(() => User, { foreignKey: "authorId" }),
  }
);

describe("join hints", () => {
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

  it("innerJoin excludes rows with no matching relation", async () => {
    await User.query().insert({ name: "Alice" });
    const alice = await User.query().first();
    await Post.query().insert({ title: "With author", authorId: (alice as any).id });
    await Post.query().insert({ title: "No author", authorId: null });

    const results = await Post.query()
      .innerJoin((p: any) => ({ author: p.author }))
      .toArray();

    expect(results).toHaveLength(1);
    expect((results[0] as any).title).toBe("With author");
  });

  it("leftJoin includes rows with no matching relation", async () => {
    await User.query().insert({ name: "Alice" });
    const alice = await User.query().first();
    await Post.query().insert({ title: "With author", authorId: (alice as any).id });
    await Post.query().insert({ title: "No author", authorId: null });

    const results = await Post.query()
      .leftJoin((p: any) => ({ author: p.author }))
      .toArray();

    expect(results).toHaveLength(2);
  });

  it("no join hint uses LEFT JOIN by default (all rows returned)", async () => {
    await Post.query().insert({ title: "No author", authorId: null });

    const results = await Post.query().toArray();
    expect(results).toHaveLength(1);
  });

  it("innerJoin with orderBy on relation column", async () => {
    const alice = await User.query().insert({ name: "Alice" });
    const bob = await User.query().insert({ name: "Bob" });
    await Post.query().insert({ title: "Post B", authorId: (bob as any).id });
    await Post.query().insert({ title: "Post A", authorId: (alice as any).id });

    const results = await Post.query()
      .innerJoin((p: any) => ({ author: p.author }))
      .orderBy((p: any) => p.author.name, "asc")
      .toArray();

    expect(results).toHaveLength(2);
    expect((results[0] as any).title).toBe("Post A");
    expect((results[1] as any).title).toBe("Post B");
  });

  it("orderBy with dot-notation relation column", async () => {
    const alice = await User.query().insert({ name: "Alice" });
    const bob = await User.query().insert({ name: "Bob" });
    await Post.query().insert({ title: "Post B", authorId: (bob as any).id });
    await Post.query().insert({ title: "Post A", authorId: (alice as any).id });

    const results = await Post.query()
      .orderBy("author.name", "asc")
      .toArray();

    expect(results).toHaveLength(2);
    expect((results[0] as any).title).toBe("Post A");
  });

  it("leftJoin with single-member syntax p => p.author", async () => {
    await User.query().insert({ name: "Alice" });
    const alice = await User.query().first();
    await Post.query().insert({ title: "With author", authorId: (alice as any).id });
    await Post.query().insert({ title: "No author", authorId: null });

    const results = await Post.query()
      .leftJoin((p: any) => p.author)
      .toArray();

    expect(results).toHaveLength(2);
  });

  it("innerJoin with single-member syntax p => p.author excludes nulls", async () => {
    await User.query().insert({ name: "Alice" });
    const alice = await User.query().first();
    await Post.query().insert({ title: "With author", authorId: (alice as any).id });
    await Post.query().insert({ title: "No author", authorId: null });

    const results = await Post.query()
      .innerJoin((p: any) => p.author)
      .toArray();

    expect(results).toHaveLength(1);
    expect((results[0] as any).title).toBe("With author");
  });
});

describe("join type SQL keywords (mock executor)", () => {
  function createMockQe(): QueryExecutor {
    return {
      dialect: "sqlite",
      query: vi.fn().mockReturnValue([]),
      run: vi.fn().mockReturnValue({ lastID: 1, changes: 0 }),
    };
  }

  function buildPostQb(qe: QueryExecutor): QueryBuilder<any, any> {
    return new QueryBuilder({
      tableName: "posts",
      columnNames: ["id", "title", "authorId"],
      qe,
      pkColumn: "id",
      whereIr: null,
      whereParams: {},
      orderBy: [],
      limitNum: null,
      offsetNum: null,
      selectIr: null,
      relations: Post.table._relations,
      resolveRelationTarget: (rel: RelationDef) => {
        const target = rel._target() as { table?: { _table: string } } | null;
        return target?.table ? { table: target.table._table, pk: "id" } : null;
      },
    });
  }

  it("rightJoin emits RIGHT JOIN keyword", async () => {
    let capturedSql = "";
    const qe = createMockQe();
    (qe.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      capturedSql = sql;
      return [];
    });
    await buildPostQb(qe).rightJoin((p: any) => ({ author: p.author })).toArray();
    expect(capturedSql).toContain("RIGHT JOIN");
  });

  it("crossJoin emits CROSS JOIN keyword", async () => {
    let capturedSql = "";
    const qe = createMockQe();
    (qe.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      capturedSql = sql;
      return [];
    });
    await buildPostQb(qe).crossJoin((p: any) => ({ author: p.author })).toArray();
    expect(capturedSql).toContain("CROSS JOIN");
  });

  it("fullJoin emits FULL OUTER JOIN keyword", async () => {
    let capturedSql = "";
    const qe = createMockQe();
    (qe.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      capturedSql = sql;
      return [];
    });
    await buildPostQb(qe).fullJoin((p: any) => ({ author: p.author })).toArray();
    expect(capturedSql).toContain("FULL OUTER JOIN");
  });

  it("innerJoin with single-member syntax emits INNER JOIN", async () => {
    let capturedSql = "";
    const qe = createMockQe();
    (qe.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      capturedSql = sql;
      return [];
    });
    await buildPostQb(qe).innerJoin((p: any) => p.author).toArray();
    expect(capturedSql).toContain("INNER JOIN");
  });

  it("last join hint wins when the same relation is hinted twice", async () => {
    let capturedSql = "";
    const qe = createMockQe();
    (qe.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      capturedSql = sql;
      return [];
    });
    // First hint: INNER; second hint: LEFT — LEFT should win.
    await buildPostQb(qe)
      .innerJoin((p: any) => p.author)
      .leftJoin((p: any) => p.author)
      .toArray();
    expect(capturedSql).toContain("LEFT JOIN");
    expect(capturedSql).not.toContain("INNER JOIN");
  });

  it("crossJoin on postgres dialect emits INNER JOIN (no ON-clause cross join)", async () => {
    let capturedSql = "";
    const qe = { ...createMockQe(), dialect: "postgres" as const };
    (qe.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      capturedSql = sql;
      return [];
    });
    await buildPostQb(qe).crossJoin((p: any) => ({ author: p.author })).toArray();
    expect(capturedSql).toContain("INNER JOIN");
    expect(capturedSql).not.toContain("CROSS JOIN");
  });
});
