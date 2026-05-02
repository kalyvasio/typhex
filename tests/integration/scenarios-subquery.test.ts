/**
 * Integration scenarios for the four subquery shapes against in-memory
 * SQLite. The runtime parser only supports the params-based WHERE IN form
 * end-to-end; the other three shapes (scalar SELECT, WHERE aggregate
 * compare, ORDER BY) are transformer-only paths. To exercise them, we
 * construct the same IR the transformer would emit, compile it via the
 * dialect's public compile primitives, and execute via `db.query()`. This
 * catches dialect quirks, schema mismatches, planner surprises, AND
 * compiler regressions — if `compileSubqueryExpr` changes its emission, a
 * scenario whose result depends on the new SQL will fail loudly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db, Entity } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { sqliteDialect } from "../../src/dbs/index.js";
import type { IrNode, IrOrderBy, IrSelect, IrSubquery } from "../../src/ir/types.js";
import { freshDb } from "../helpers.js";

/** Drive the same compile pipeline QueryBuilder uses, but with hand-built
 *  IR — so the test exercises IR → compiler → SQLite end-to-end. */
function runIrQuery(
  db: Db,
  table: string,
  columnNames: string[],
  select: IrSelect,
  whereIr: IrNode | null,
  orderBy: IrOrderBy[],
  rowParam: string,
): Promise<Record<string, unknown>[]> {
  const opts = { tableAlias: "t0", paramToAlias: { [rowParam]: "t0" } };
  const selectListResult = sqliteDialect.compileSelectList(select, columnNames, opts);
  const whereResult = sqliteDialect.compileWhere(whereIr, opts);
  const orderByResult = sqliteDialect.compileOrderBy(orderBy, opts);
  const { sql, params } = sqliteDialect.compileSelect({
    table,
    selectList: selectListResult.sql,
    selectListParams: selectListResult.params,
    whereSql: whereResult.sql,
    whereParams: whereResult.params,
    orderBySql: orderByResult.sql,
    orderByParams: orderByResult.params,
    limitNum: null,
    offsetNum: null,
  });
  return db.query(sql, params) as Promise<Record<string, unknown>[]>;
}

describe("subquery scenarios (SQLite)", () => {
  const Author = Entity("authors", {
    id: "integer primary key autoincrement",
    name: "text not null",
  });

  const Post = Entity("posts", {
    id: "integer primary key autoincrement",
    title: "text not null",
    score: "integer not null",
    active: "integer not null",
    authorId: "integer not null",
  });

  const AUTHOR_COLS = ["id", "name"];

  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(Author);
    registerEntity(Post);
    db = freshDb();
    await db.migrate();

    // Alice: 3 posts (2 active scoring 10+20, 1 inactive scoring 30).
    // Bob: 1 active post scoring 50. Carol: 0 posts.
    const alice = (await Author.query().insert({ name: "Alice" })) as { id: number };
    const bob = (await Author.query().insert({ name: "Bob" })) as { id: number };
    await Author.query().insert({ name: "Carol" });

    await Post.query().insert({ title: "A1", score: 10, active: 1, authorId: alice.id });
    await Post.query().insert({ title: "A2", score: 20, active: 1, authorId: alice.id });
    await Post.query().insert({ title: "A3", score: 30, active: 0, authorId: alice.id });
    await Post.query().insert({ title: "B1", score: 50, active: 1, authorId: bob.id });
  });

  afterEach(async () => {
    await db.close();
  });

  // Subquery shape: COUNT of posts where p.authorId === outer a.id.
  const correlatedPostCount: IrSubquery = {
    kind: "subquery",
    tableName: "posts",
    selectIr: { param: "p", paths: [], aggregates: [{ kind: "aggregate", func: "COUNT", arg: null }] },
    whereIr: {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "p", path: ["authorId"] },
      right: { kind: "member", param: "a", path: ["id"] },
    },
    whereParams: {},
    innerParamNames: ["p"],
  };

  it("non-correlated scalar count() in SELECT returns the same value per row", async () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectIr: { param: "p", paths: [], aggregates: [{ kind: "aggregate", func: "COUNT", arg: null }] },
      whereIr: null,
      whereParams: {},
    };
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [{ alias: "totalPosts", subquery: sub }],
    };
    const orderBy: IrOrderBy[] = [
      { expr: { kind: "member", param: "a", path: ["id"] }, direction: "asc" },
    ];
    const rows = (await runIrQuery(
      db,
      "authors",
      AUTHOR_COLS,
      select,
      null,
      orderBy,
      "a",
    )) as Array<{
      name: string;
      totalPosts: number;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => Number(r.totalPosts) === 4)).toBe(true);
  });

  it("correlated count() in SELECT yields per-author post counts", async () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [{ alias: "postCount", subquery: correlatedPostCount }],
    };
    const orderBy: IrOrderBy[] = [
      { expr: { kind: "member", param: "a", path: ["id"] }, direction: "asc" },
    ];
    const rows = (await runIrQuery(
      db,
      "authors",
      AUTHOR_COLS,
      select,
      null,
      orderBy,
      "a",
    )) as Array<{
      name: string;
      postCount: number;
    }>;
    expect(rows.map((r) => [r.name, Number(r.postCount)])).toEqual([
      ["Alice", 3],
      ["Bob", 1],
      ["Carol", 0],
    ]);
  });

  it("WHERE aggregate compare: authors with more than 1 post", async () => {
    const select: IrSelect = { param: "a", paths: [], rest: true };
    const whereIr: IrNode = {
      kind: "binary",
      op: ">",
      left: correlatedPostCount,
      right: { kind: "const", value: 1 },
    };
    const orderBy: IrOrderBy[] = [
      { expr: { kind: "member", param: "a", path: ["id"] }, direction: "asc" },
    ];
    const rows = (await runIrQuery(
      db,
      "authors",
      AUTHOR_COLS,
      select,
      whereIr,
      orderBy,
      "a",
    )) as Array<{
      name: string;
    }>;
    expect(rows.map((r) => r.name)).toEqual(["Alice"]);
  });

  it("ORDER BY correlated count() sorts authors by post count desc", async () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
    };
    const orderBy: IrOrderBy[] = [
      { expr: correlatedPostCount, direction: "desc" },
      { expr: { kind: "member", param: "a", path: ["id"] }, direction: "asc" },
    ];
    const rows = (await runIrQuery(
      db,
      "authors",
      AUTHOR_COLS,
      select,
      null,
      orderBy,
      "a",
    )) as Array<{
      name: string;
    }>;
    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("top-N IN subquery: authors whose id is among the top 2 active-post scorers", async () => {
    // Build: SELECT * FROM authors WHERE id IN (
    //   SELECT authorId FROM posts WHERE active=1 ORDER BY score DESC LIMIT 2
    // )
    // Top 2 active scores: B1 (50, Bob), A2 (20, Alice). → Alice + Bob.
    const innerWhere: IrNode = {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "p", path: ["active"] },
      right: { kind: "const", value: 1 },
    };
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectIr: { param: "p", paths: [["authorId"]] },
      whereIr: innerWhere,
      whereParams: {},
      orderBy: [{ expr: { kind: "member", param: "p", path: ["score"] }, direction: "desc" }],
      limitNum: 2,
    };
    const whereIr: IrNode = {
      kind: "in",
      left: { kind: "member", param: "a", path: ["id"] },
      right: sub,
    };
    const select: IrSelect = { param: "a", paths: [], rest: true };
    const orderBy: IrOrderBy[] = [
      { expr: { kind: "member", param: "a", path: ["id"] }, direction: "asc" },
    ];
    const rows = (await runIrQuery(
      db,
      "authors",
      AUTHOR_COLS,
      select,
      whereIr,
      orderBy,
      "a",
    )) as Array<{
      name: string;
    }>;
    expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "Bob"]);
  });

  it("WHERE IN subquery (params-based) filters authors with at least one active post", async () => {
    const activeAuthorIds = Post.query()
      .where((p: any) => p.active === 1)
      .select((p: any) => ({ authorId: p.authorId }));

    const rows = (await Author.query()
      .where((a: any) => a.id in activeAuthorIds, { activeAuthorIds })
      .orderBy("id", "asc")
      .toArray()) as Array<{ name: string }>;

    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob"]);
  });
});
