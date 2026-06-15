/**
 * Unit tests for scalar subqueries used as ORDER BY sort keys.
 */

import { describe, it, expect } from "vitest";
import { sqliteQueryCompiler, postgresQueryCompiler } from "../../src/dbs/index.js";
import type { OrderItem } from "../../src/orm/expr.js";
import { col, eq, konst, selectPlan, countPostsSelect } from "./subquery-ref-helpers.js";

const correlatedPostCount = selectPlan({
  selectItems: countPostsSelect,
  where: eq(col("t1", "authorId"), col("t0", "id")),
});

describe("ORDER BY subquery", () => {
  it("SQLite: emits subquery as sort key (correlated COUNT)", () => {
    const orders: OrderItem[] = [
      { expr: { kind: "subquery", plan: correlatedPostCount }, direction: "desc" },
    ];
    const { sql, params } = sqliteQueryCompiler.compileOrderByExpr(orders);
    expect(sql).toBe(
      `(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) DESC`,
    );
    expect(params).toEqual([]);
  });

  it("PostgreSQL: literal predicate uses placeholder, sort key threads params", () => {
    const sub = selectPlan({
      selectItems: countPostsSelect,
      where: eq(col("t1", "active"), konst(true)),
    });
    const orders: OrderItem[] = [{ expr: { kind: "subquery", plan: sub }, direction: "asc" }];
    const { sql, params } = postgresQueryCompiler.compileOrderByExpr(orders);
    expect(sql).toBe(`(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."active" = $1)) ASC`);
    expect(params).toEqual([true]);
  });

  it("mixes member sort key with subquery sort key", () => {
    const orders: OrderItem[] = [
      { expr: col("t0", "name"), direction: "asc" },
      { expr: { kind: "subquery", plan: correlatedPostCount }, direction: "desc" },
    ];
    const { sql, params } = sqliteQueryCompiler.compileOrderByExpr(orders);
    expect(sql).toContain(`"t0"."name" ASC`);
    expect(sql).toContain(
      `(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) DESC`,
    );
    expect(params).toEqual([]);
  });
});
