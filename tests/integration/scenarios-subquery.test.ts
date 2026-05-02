/**
 * Integration scenarios for the four subquery shapes against in-memory
 * SQLite. The runtime parser only supports the params-based WHERE IN form
 * end-to-end; the other three shapes (scalar SELECT, WHERE aggregate
 * compare, ORDER BY) are transformer-only paths. To exercise them, we
 * construct the same Expr the planner would emit, compile it via the
 * dialect's compile primitives, and execute via `db.query()`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db, Entity } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { sqliteDialect } from "../../src/dbs/index.js";
import {
  compileOrderByExpr,
  compileSelectListExpr,
  compileWhereExpr,
} from "../../src/dbs/shared-dialect.js";
import type { DialectImpl } from "../../src/dbs/types.js";
import type {
  Expr,
  ExprAggregate,
  OrderItem,
  SelectItem,
} from "../../src/orm/expr.js";
import type { IrNode } from "../../src/ir/types.js";
import { freshDb } from "../helpers.js";
import {
  bin,
  col,
  countPostsSelect,
  eq,
  konst,
  selectPlan,
} from "../dbs/subquery-ref-helpers.js";
import type { QueryPlan } from "../../src/orm/query-plan.js";

function aggCompiler(dialect: DialectImpl) {
  return dialect.compileAggregate
    ? (agg: ExprAggregate, fn: (n: Expr, p: unknown[]) => string, p: unknown[]) =>
        dialect.compileAggregate!(agg, fn, p)
    : undefined;
}

/** Drive the same compile pipeline QueryBuilder uses, but with hand-built Expr. */
function runExprQuery(
  db: Db,
  table: string,
  columnNames: string[],
  selectItems: SelectItem[],
  selectAll: boolean,
  whereExpr: Expr | null,
  orderBy: OrderItem[],
): Promise<Record<string, unknown>[]> {
  const selectListResult = compileSelectListExpr(
    selectItems,
    selectAll,
    "t0",
    columnNames,
    sqliteDialect,
    aggCompiler(sqliteDialect),
  );
  const whereResult = compileWhereExpr(whereExpr, sqliteDialect);
  const orderByResult = compileOrderByExpr(orderBy, sqliteDialect);
  const { sql, params } = sqliteDialect.compileSelect({
    table,
    tableAlias: "t0",
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

  // Subquery: SELECT COUNT(*) FROM posts AS t1 WHERE t1.authorId = t0.id
  const correlatedPostCount: QueryPlan = selectPlan({
    selectItems: countPostsSelect,
    where: eq(col("t1", "authorId"), col("t0", "id")),
  });

  it("non-correlated scalar count() in SELECT returns the same value per row", async () => {
    const sub: QueryPlan = selectPlan({ selectItems: countPostsSelect });
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: sub }, alias: "totalPosts" },
    ];
    const orderBy: OrderItem[] = [{ expr: col("t0", "id"), direction: "asc" }];
    const rows = (await runExprQuery(db, "authors", AUTHOR_COLS, items, false, null, orderBy)) as Array<{
      name: string;
      totalPosts: number;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => Number(r.totalPosts) === 4)).toBe(true);
  });

  it("correlated count() in SELECT yields per-author post counts", async () => {
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: correlatedPostCount }, alias: "postCount" },
    ];
    const orderBy: OrderItem[] = [{ expr: col("t0", "id"), direction: "asc" }];
    const rows = (await runExprQuery(db, "authors", AUTHOR_COLS, items, false, null, orderBy)) as Array<{
      name: string;
      postCount: number;
    }>;
    expect(rows.map((r) => [r.name, Number(r.postCount)])).toEqual([
      ["Alice", 3],
      ["Bob", 1],
      ["Carol", 0],
    ]);
  });

  it("captured subqueryRef in SELECT yields per-author post counts", async () => {
    const innerWhere: IrNode = {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "p", path: ["authorId"] },
      right: { kind: "member", param: "a", path: ["id"] },
    };
    const postCount = (Post.query() as any)
      .where(innerWhere, {})
      .select({
        param: "u",
        paths: [],
        aggregates: [{ kind: "aggregate", func: "COUNT", arg: null }],
      });

    const rows = (await (Author.query() as any)
      .select(
        {
          param: "a",
          paths: [["name"]],
          aliases: ["name"],
          subqueries: [
            {
              alias: "postCount",
              subquery: { kind: "subqueryRef", key: "_sub0", localParamNames: ["p"] },
            },
          ],
        },
        { _sub0: postCount },
      )
      .orderBy("id", "asc")
      .toArray()) as Array<{ name: string; postCount: number }>;

    expect(rows.map((r) => [r.name, Number(r.postCount)])).toEqual([
      ["Alice", 3],
      ["Bob", 1],
      ["Carol", 0],
    ]);
  });

  it("WHERE aggregate compare: authors with more than 1 post", async () => {
    const items: SelectItem[] = AUTHOR_COLS.map((c) => ({ expr: col("t0", c) }));
    const where: Expr = bin(">", { kind: "subquery", plan: correlatedPostCount }, konst(1));
    const orderBy: OrderItem[] = [{ expr: col("t0", "id"), direction: "asc" }];
    const rows = (await runExprQuery(
      db,
      "authors",
      AUTHOR_COLS,
      items,
      false,
      where,
      orderBy,
    )) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(["Alice"]);
  });

  it("QueryBuilder keeps outer aliases for correlated WHERE subqueries", async () => {
    const innerWhere: IrNode = {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "p", path: ["authorId"] },
      right: { kind: "member", param: "a", path: ["id"] },
    };
    const postCount = (Post.query() as any)
      .where(innerWhere, {})
      .select({
        param: "u",
        paths: [],
        aggregates: [{ kind: "aggregate", func: "COUNT", arg: null }],
      });

    const whereIr: IrNode = {
      kind: "binary",
      op: ">",
      left: { kind: "subqueryRef", key: "count", localParamNames: ["p"] },
      right: { kind: "const", value: 1 },
    };

    const rows = (await Author.query()
      .where(whereIr, { count: postCount })
      .orderBy("id", "asc")
      .toArray()) as Array<{ name: string }>;

    expect(rows.map((r) => r.name)).toEqual(["Alice"]);
  });

  it("ORDER BY correlated count() sorts authors by post count desc", async () => {
    const items: SelectItem[] = [{ expr: col("t0", "name"), alias: "name" }];
    const orderBy: OrderItem[] = [
      { expr: { kind: "subquery", plan: correlatedPostCount }, direction: "desc" },
      { expr: col("t0", "id"), direction: "asc" },
    ];
    const rows = (await runExprQuery(db, "authors", AUTHOR_COLS, items, false, null, orderBy)) as Array<{
      name: string;
    }>;
    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("top-N IN subquery: authors whose id is among the top 2 active-post scorers", async () => {
    // Top 2 active scores: B1 (50, Bob), A2 (20, Alice). → Alice + Bob.
    const sub: QueryPlan = selectPlan({
      selectItems: [{ expr: col("t1", "authorId") }],
      where: eq(col("t1", "active"), konst(1)),
      orderBy: [{ expr: col("t1", "score"), direction: "desc" }],
      limitNum: 2,
    });
    const where: Expr = {
      kind: "in",
      left: col("t0", "id"),
      right: { kind: "subquery", plan: sub },
    };
    const items: SelectItem[] = AUTHOR_COLS.map((c) => ({ expr: col("t0", c) }));
    const orderBy: OrderItem[] = [{ expr: col("t0", "id"), direction: "asc" }];
    const rows = (await runExprQuery(
      db,
      "authors",
      AUTHOR_COLS,
      items,
      false,
      where,
      orderBy,
    )) as Array<{ name: string }>;
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

  it("WHERE IN subquery (params-based) also works for count()", async () => {
    const activeAuthorIds = Post.query()
      .where((p: any) => p.active === 1)
      .select((p: any) => ({ authorId: p.authorId }));

    const count = await Author.query()
      .where((a: any) => a.id in activeAuthorIds, { activeAuthorIds })
      .count();

    expect(count).toBe(2);
  });
});
