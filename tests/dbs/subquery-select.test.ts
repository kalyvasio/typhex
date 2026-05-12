import { describe, expect, it } from "vitest";
import { postgresDialect, sqliteDialect } from "../../src/dbs/index.js";
import { compileSelectListExpr } from "../../src/dbs/shared-dialect.js";
import type { DialectImpl } from "../../src/dbs/types.js";
import type { Expr, ExprAggregate, SelectItem } from "../../src/orm/expr.js";
import { col, eq, konst, selectPlan, countPostsSelect } from "./subquery-ref-helpers.js";

function aggFn(dialect: DialectImpl) {
  return dialect.compileAggregate
    ? (
        agg: ExprAggregate,
        fn: (n: import("../../src/orm/expr.js").Expr, p: unknown[]) => string,
        p: unknown[],
      ) => dialect.compileAggregate!(agg, fn, p)
    : undefined;
}

const countAllPosts = selectPlan({
  selectItems: countPostsSelect,
});

const countActivePosts = selectPlan({
  selectItems: countPostsSelect,
  where: eq(col("t1", "active"), konst(true)),
});

const sumActivePostScores = selectPlan({
  selectItems: [
    { expr: { kind: "aggregate", func: "SUM", arg: col("t1", "score") } as ExprAggregate },
  ],
  where: eq(col("t1", "active"), konst(true)),
});

describe("Scalar subquery columns in SELECT", () => {
  it('SQLite: emits (SELECT COUNT(*) FROM ...) AS "<alias>" with no params', () => {
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: countAllPosts }, alias: "totalPosts" },
    ];
    const { sql, params } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id", "name"],
      sqliteDialect,
      aggFn(sqliteDialect),
    );
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1) AS "totalPosts"`,
    );
    expect(params).toEqual([]);
  });

  it("SQLite: subquery with WHERE pushes params and emits placeholders", () => {
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: countActivePosts }, alias: "activePosts" },
    ];
    const { sql, params } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id", "name"],
      sqliteDialect,
      aggFn(sqliteDialect),
    );
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."active" = ?)) AS "activePosts"`,
    );
    expect(params).toEqual([true]);
  });

  it("PostgreSQL: subquery with WHERE numbers placeholders starting at $1", () => {
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: countActivePosts }, alias: "activePosts" },
    ];
    const { sql, params } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id", "name"],
      postgresDialect,
      aggFn(postgresDialect),
    );
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."active" = $1)) AS "activePosts"`,
    );
    expect(params).toEqual([true]);
  });

  it('emits SUM("alias"."col") for non-COUNT aggregates', () => {
    const items: SelectItem[] = [
      { expr: { kind: "subquery", plan: sumActivePostScores }, alias: "totalScore" },
    ];
    const { sql, params } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id", "name"],
      sqliteDialect,
      aggFn(sqliteDialect),
    );
    expect(sql).toBe(
      `(SELECT SUM("t1"."score") FROM "posts" AS "t1" WHERE ("t1"."active" = ?)) AS "totalScore"`,
    );
    expect(params).toEqual([true]);
  });

  it("multiple subquery columns share params in order", () => {
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: countActivePosts }, alias: "active" },
      { expr: { kind: "subquery", plan: sumActivePostScores }, alias: "totalScore" },
    ];
    const { sql, params } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id", "name"],
      postgresDialect,
      aggFn(postgresDialect),
    );
    expect(sql).toBe(
      `"t0"."name" AS "name", ` +
        `(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."active" = $1)) AS "active", ` +
        `(SELECT SUM("t1"."score") FROM "posts" AS "t1" WHERE ("t1"."active" = $2)) AS "totalScore"`,
    );
    expect(params).toEqual([true, true]);
  });

  it("PostgreSQL: compilePlan numbers SELECT-list params before WHERE params", () => {
    const statusParam: Expr = { kind: "param", name: "status" };
    const countryParam: Expr = { kind: "param", name: "country" };
    const countPostsByStatus = selectPlan({
      selectItems: countPostsSelect,
      where: eq(col("t1", "status"), statusParam),
      whereParams: { status: "published" },
    });
    const plan = selectPlan({
      tableName: "users",
      tableAlias: "t0",
      columnNames: ["id", "name", "country"],
      selectItems: [
        { expr: col("t0", "name"), alias: "name" },
        { expr: { kind: "subquery", plan: countPostsByStatus }, alias: "postCount" },
      ],
      where: eq(col("t0", "country"), countryParam),
      whereParams: { country: "US" },
    });

    const { sql, params } = postgresDialect.compilePlan(plan);

    expect(sql).toContain('"t1"."status" = $1');
    expect(sql).toContain('"t0"."country" = $2');
    expect(params).toEqual(["published", "US"]);
  });

  it("subquery alias avoids outer JOIN alias collision", () => {
    // When the outer query has a JOIN that occupies t1, the planner allocates
    // t2 for the subquery. Here we hand-build the inner plan with tableAlias "t2".
    const t2Plan = selectPlan({
      tableAlias: "t2",
      selectItems: [{ expr: { kind: "aggregate", func: "COUNT", arg: null } as ExprAggregate }],
      where: eq(col("t2", "active"), konst(true)),
    });
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: t2Plan }, alias: "active" },
    ];
    const { sql } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id", "name"],
      sqliteDialect,
      aggFn(sqliteDialect),
    );
    expect(sql).toContain(`AS "t2"`);
    expect(sql).not.toMatch(/FROM "posts" AS "t1"/);
  });

  it("regular aggregates and subqueries coexist in select list", () => {
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      {
        expr: {
          kind: "aggregate",
          func: "COUNT",
          arg: null,
          alias: "rowCount",
        } as ExprAggregate,
      },
      { expr: { kind: "subquery", plan: countAllPosts }, alias: "totalPosts" },
    ];
    const { sql } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id", "name"],
      sqliteDialect,
      aggFn(sqliteDialect),
    );
    expect(sql).toBe(
      `"t0"."name" AS "name", COUNT(*) AS "rowCount", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1) AS "totalPosts"`,
    );
  });

  it("emits LIMIT inside the subquery for COUNT(*) with limitNum", () => {
    const sub = selectPlan({ selectItems: countPostsSelect, limitNum: 10 });
    const items: SelectItem[] = [{ expr: { kind: "subquery", plan: sub }, alias: "c" }];
    const { sql, params } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id"],
      sqliteDialect,
      aggFn(sqliteDialect),
    );
    expect(sql).toBe(`(SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1 LIMIT ?) AS "c"`);
    expect(params).toEqual([10]);
  });

  it("emits ORDER BY ... LIMIT for top-N subquery in SELECT", () => {
    const sub = selectPlan({
      selectItems: [
        {
          expr: {
            kind: "aggregate",
            func: "MAX",
            arg: col("t1", "score"),
          } as ExprAggregate,
        },
      ],
      orderBy: [{ expr: col("t1", "score"), direction: "desc" }],
      limitNum: 1,
    });
    const items: SelectItem[] = [{ expr: { kind: "subquery", plan: sub }, alias: "topScore" }];
    const { sql, params } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id"],
      sqliteDialect,
      aggFn(sqliteDialect),
    );
    expect(sql).toBe(
      `(SELECT MAX("t1"."score") FROM "posts" AS "t1" WHERE 1=1 ORDER BY "t1"."score" DESC LIMIT ?) AS "topScore"`,
    );
    expect(params).toEqual([1]);
  });

  it("emits LIMIT and OFFSET inside the subquery", () => {
    const sub = selectPlan({
      selectItems: countPostsSelect,
      limitNum: 5,
      offsetNum: 2,
    });
    const items: SelectItem[] = [{ expr: { kind: "subquery", plan: sub }, alias: "c" }];
    const { sql, params } = compileSelectListExpr(
      items,
      false,
      "t0",
      ["id"],
      sqliteDialect,
      aggFn(sqliteDialect),
    );
    expect(sql).toBe(`(SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1 LIMIT ? OFFSET ?) AS "c"`);
    expect(params).toEqual([5, 2]);
  });
});
