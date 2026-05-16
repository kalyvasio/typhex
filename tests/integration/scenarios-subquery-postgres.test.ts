/**
 * PostgreSQL integration scenarios for the four subquery shapes. Mirrors
 * scenarios-subquery.test.ts: hand-built Expr is compiled via the Postgres
 * dialect and executed against a real database. Skipped unless
 * `TYPHEX_POSTGRES_URL` is set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db, Entity, createPostgresDriver } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { postgresQueryCompiler } from "../../src/dbs/index.js";
import {
  compileOrderByExpr,
  compileSelectListExpr,
  compileWhereExpr,
} from "../../src/dbs/shared-dialect.js";
import type { DialectImpl } from "../../src/dbs/types.js";
import type { Expr, ExprAggregate, OrderItem, SelectItem } from "../../src/orm/expr.js";
import type { QueryPlan } from "../../src/orm/helpers/query-plan/query-plan.js";
import { bin, col, countPostsSelect, eq, konst, selectPlan } from "../dbs/subquery-ref-helpers.js";

const postgresDialect = postgresQueryCompiler as any;

const connectionString =
  process.env.TYPHEX_POSTGRES_URL ?? "postgresql://localhost:5432/typhex_test";

function hasPostgres(): boolean {
  return !!process.env.TYPHEX_POSTGRES_URL;
}

function freshDb() {
  return new Db(createPostgresDriver({ connectionString }));
}

function aggCompiler(dialect: DialectImpl) {
  return dialect.compileAggregate
    ? (agg: ExprAggregate, fn: (n: Expr, p: unknown[]) => string, p: unknown[]) =>
        dialect.compileAggregate!(agg, fn, p)
    : undefined;
}

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
    postgresDialect,
    aggCompiler(postgresDialect),
  );
  const whereResult = compileWhereExpr(whereExpr, postgresDialect);
  const orderByResult = compileOrderByExpr(orderBy, postgresDialect);
  const { sql, params } = postgresDialect.compileSelect({
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

describe("subquery scenarios (postgres)", () => {
  const Author = Entity("pg_subq_authors", {
    id: "SERIAL PRIMARY KEY",
    name: "text not null",
  });

  const Post = Entity("pg_subq_posts", {
    id: "SERIAL PRIMARY KEY",
    title: "text not null",
    score: "integer not null",
    active: "integer not null",
    authorId: "integer not null",
  });

  const AUTHOR_COLS = ["id", "name"];

  let db: Db;

  beforeEach(async () => {
    if (!hasPostgres()) return;
    clearRegistry();
    registerEntity(Author);
    registerEntity(Post);
    db = freshDb();
    await db.run('DROP TABLE IF EXISTS "pg_subq_posts"');
    await db.run('DROP TABLE IF EXISTS "pg_subq_authors"');
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
    if (db) await db.close();
  });

  const correlatedPostCount: QueryPlan = selectPlan({
    tableName: "pg_subq_posts",
    selectItems: countPostsSelect,
    where: eq(col("t1", "authorId"), col("t0", "id")),
  });

  it(
    "non-correlated scalar count() in SELECT returns the same value per row",
    async () => {
      const sub: QueryPlan = selectPlan({
        tableName: "pg_subq_posts",
        selectItems: countPostsSelect,
      });
      const items: SelectItem[] = [
        { expr: col("t0", "name"), alias: "name" },
        { expr: { kind: "subquery", plan: sub }, alias: "totalPosts" },
      ];
      const orderBy: OrderItem[] = [{ expr: col("t0", "id"), direction: "asc" }];
      const rows = (await runExprQuery(
        db,
        "pg_subq_authors",
        AUTHOR_COLS,
        items,
        false,
        null,
        orderBy,
      )) as Array<{ name: string; totalPosts: number | string }>;
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => Number(r.totalPosts) === 4)).toBe(true);
    },
    { skip: !hasPostgres() },
  );

  it(
    "correlated count() in SELECT yields per-author post counts",
    async () => {
      const items: SelectItem[] = [
        { expr: col("t0", "name"), alias: "name" },
        { expr: { kind: "subquery", plan: correlatedPostCount }, alias: "postCount" },
      ];
      const orderBy: OrderItem[] = [{ expr: col("t0", "id"), direction: "asc" }];
      const rows = (await runExprQuery(
        db,
        "pg_subq_authors",
        AUTHOR_COLS,
        items,
        false,
        null,
        orderBy,
      )) as Array<{ name: string; postCount: number | string }>;
      expect(rows.map((r) => [r.name, Number(r.postCount)])).toEqual([
        ["Alice", 3],
        ["Bob", 1],
        ["Carol", 0],
      ]);
    },
    { skip: !hasPostgres() },
  );

  it(
    "WHERE aggregate compare: authors with more than 1 post",
    async () => {
      const items: SelectItem[] = AUTHOR_COLS.map((c) => ({ expr: col("t0", c) }));
      const where: Expr = bin(">", { kind: "subquery", plan: correlatedPostCount }, konst(1));
      const orderBy: OrderItem[] = [{ expr: col("t0", "id"), direction: "asc" }];
      const rows = (await runExprQuery(
        db,
        "pg_subq_authors",
        AUTHOR_COLS,
        items,
        false,
        where,
        orderBy,
      )) as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(["Alice"]);
    },
    { skip: !hasPostgres() },
  );

  it(
    "ORDER BY correlated count() sorts authors by post count desc",
    async () => {
      const items: SelectItem[] = [{ expr: col("t0", "name"), alias: "name" }];
      const orderBy: OrderItem[] = [
        { expr: { kind: "subquery", plan: correlatedPostCount }, direction: "desc" },
        { expr: col("t0", "id"), direction: "asc" },
      ];
      const rows = (await runExprQuery(
        db,
        "pg_subq_authors",
        AUTHOR_COLS,
        items,
        false,
        null,
        orderBy,
      )) as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob", "Carol"]);
    },
    { skip: !hasPostgres() },
  );

  it(
    "top-N IN subquery: authors whose id is among the top 2 active-post scorers",
    async () => {
      const sub: QueryPlan = selectPlan({
        tableName: "pg_subq_posts",
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
        "pg_subq_authors",
        AUTHOR_COLS,
        items,
        false,
        where,
        orderBy,
      )) as Array<{ name: string }>;
      expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "Bob"]);
    },
    { skip: !hasPostgres() },
  );

  it(
    "WHERE IN subquery (params-based) filters authors with at least one active post",
    async () => {
      const activeAuthorIds = Post.query()
        .where((p: any) => p.active === 1)
        .select((p: any) => ({ authorId: p.authorId }));

      const rows = (await Author.query()
        .where((a: any) => a.id in activeAuthorIds, { activeAuthorIds })
        .orderBy("id", "asc")
        .toArray()) as Array<{ name: string }>;

      expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob"]);
    },
    { skip: !hasPostgres() },
  );
});
