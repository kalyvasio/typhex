/**
 * Unit tests for WHERE IN subquery compilation (SQLite and PostgreSQL dialects).
 */

import { describe, it, expect } from "vitest";
import { getDialect } from "../../src/dbs/index.js";
import { compileWhereExpr } from "../../src/dbs/shared-dialect.js";
import type { Expr } from "../../src/orm/expr.js";
import { col, eq, konst, selectPlan } from "./subquery-ref-helpers.js";

describe("IN subquery compilation", () => {
  const subPlan = selectPlan({
    selectItems: [{ expr: col("t1", "id") }],
    where: eq(col("t1", "active"), konst(true)),
  });

  const expr: Expr = {
    kind: "in",
    left: col("t0", "postId"),
    right: { kind: "subquery", plan: subPlan },
  };

  it("SQLite: compiles IN subquery correctly", () => {
    const result = compileWhereExpr(expr, getDialect("sqlite"));
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE ("t1"."active" = ?))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("PostgreSQL: compiles IN subquery correctly", () => {
    const result = compileWhereExpr(expr, getDialect("postgres"));
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE ("t1"."active" = $1))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("SQLite: compiles NOT IN subquery correctly (negated)", () => {
    const negated: Expr = { ...expr, negated: true } as Expr;
    const result = compileWhereExpr(negated, getDialect("sqlite"));
    expect(result.sql).toBe(
      `"t0"."postId" NOT IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE ("t1"."active" = ?))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("avoids alias collision when outer query already uses t1 (e.g. via JOIN)", () => {
    // Subquery is built with t2 — the planner allocates fresh aliases.
    const t2Plan = selectPlan({
      tableAlias: "t2",
      selectItems: [{ expr: col("t2", "id") }],
      where: eq(col("t2", "active"), konst(true)),
    });
    const result = compileWhereExpr(
      {
        kind: "in",
        left: col("t0", "postId"),
        right: { kind: "subquery", plan: t2Plan },
      },
      getDialect("sqlite"),
    );
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t2"."id" FROM "posts" AS "t2" WHERE ("t2"."active" = ?))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("supports a custom outer param name (no u/p/e/t heuristic)", () => {
    // Outer column is just an alias — naming is irrelevant in Expr-land.
    const result = compileWhereExpr(
      {
        kind: "in",
        left: col("t0", "postId"),
        right: { kind: "subquery", plan: subPlan },
      },
      getDialect("sqlite"),
    );
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE ("t1"."active" = ?))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("nested IN subqueries get distinct aliases", () => {
    const innerPlan = selectPlan({
      tableName: "users",
      tableAlias: "t2",
      selectItems: [{ expr: col("t2", "id") }],
      where: eq(col("t2", "active"), konst(true)),
    });
    const middlePlan = selectPlan({
      tableAlias: "t1",
      selectItems: [{ expr: col("t1", "id") }],
      where: {
        kind: "in",
        left: col("t1", "authorId"),
        right: { kind: "subquery", plan: innerPlan },
      },
    });
    const result = compileWhereExpr(
      {
        kind: "in",
        left: col("t0", "postId"),
        right: { kind: "subquery", plan: middlePlan },
      },
      getDialect("sqlite"),
    );
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE "t1"."authorId" IN (SELECT "t2"."id" FROM "users" AS "t2" WHERE ("t2"."active" = ?)))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("compiles top-N IN subquery: SELECT col ORDER BY ... LIMIT n", () => {
    const sub = selectPlan({
      selectItems: [{ expr: col("t1", "id") }],
      where: null,
      orderBy: [{ expr: col("t1", "score"), direction: "desc" }],
      limitNum: 3,
    });
    const result = compileWhereExpr(
      {
        kind: "in",
        left: col("t0", "postId"),
        right: { kind: "subquery", plan: sub },
      },
      getDialect("sqlite"),
    );
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE 1=1 ORDER BY "t1"."score" DESC LIMIT ?)`,
    );
    expect(result.params).toEqual([3]);
  });

  it("compiles subquery with no WHERE", () => {
    const sub = selectPlan({
      selectItems: [{ expr: col("t1", "id") }],
      where: null,
    });
    const result = compileWhereExpr(
      {
        kind: "in",
        left: col("t0", "postId"),
        right: { kind: "subquery", plan: sub },
      },
      getDialect("sqlite"),
    );
    expect(result.sql).toBe(`"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE 1=1)`);
    expect(result.params).toEqual([]);
  });
});
