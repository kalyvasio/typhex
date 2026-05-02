/**
 * PostgreSQL integration scenarios for the four subquery shapes. Mirrors
 * scenarios-subquery.test.ts: hand-built IR is compiled via the Postgres
 * dialect and executed against a real database. Skipped unless
 * `TYPHEX_POSTGRES_URL` is set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db, Entity, createPostgresDriver } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { postgresDialect } from "../../src/dbs/index.js";
import type { IrNode, IrOrderBy, IrSelect, IrSubquery } from "../../src/ir/types.js";

const connectionString =
  process.env.TYPHEX_POSTGRES_URL ?? "postgresql://localhost:5432/typhex_test";

function hasPostgres(): boolean {
  return !!process.env.TYPHEX_POSTGRES_URL;
}

function freshDb() {
  return new Db(createPostgresDriver({ connectionString }));
}

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
  const selectListResult = postgresDialect.compileSelectList(select, columnNames, opts);
  const whereResult = postgresDialect.compileWhere(whereIr, opts);
  const orderByResult = postgresDialect.compileOrderBy(orderBy, opts);
  const { sql, params } = postgresDialect.compileSelect({
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

  const correlatedPostCount: IrSubquery = {
    kind: "subquery",
    tableName: "pg_subq_posts",
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

  it(
    "non-correlated scalar count() in SELECT returns the same value per row",
    async () => {
      const sub: IrSubquery = {
        kind: "subquery",
        tableName: "pg_subq_posts",
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
        "pg_subq_authors",
        AUTHOR_COLS,
        select,
        null,
        orderBy,
        "a",
      )) as Array<{ name: string; totalPosts: number | string }>;
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => Number(r.totalPosts) === 4)).toBe(true);
    },
    { skip: !hasPostgres() },
  );

  it(
    "correlated count() in SELECT yields per-author post counts",
    async () => {
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
        "pg_subq_authors",
        AUTHOR_COLS,
        select,
        null,
        orderBy,
        "a",
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
        "pg_subq_authors",
        AUTHOR_COLS,
        select,
        whereIr,
        orderBy,
        "a",
      )) as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(["Alice"]);
    },
    { skip: !hasPostgres() },
  );

  it(
    "ORDER BY correlated count() sorts authors by post count desc",
    async () => {
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
        "pg_subq_authors",
        AUTHOR_COLS,
        select,
        null,
        orderBy,
        "a",
      )) as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob", "Carol"]);
    },
    { skip: !hasPostgres() },
  );

  it(
    "top-N IN subquery: authors whose id is among the top 2 active-post scorers",
    async () => {
      const innerWhere: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "p", path: ["active"] },
        right: { kind: "const", value: 1 },
      };
      const sub: IrSubquery = {
        kind: "subquery",
        tableName: "pg_subq_posts",
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
        "pg_subq_authors",
        AUTHOR_COLS,
        select,
        whereIr,
        orderBy,
        "a",
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
