/**
 * Unit tests for using a scalar (aggregate) subquery on either side of a
 * binary comparison in a WHERE / HAVING clause.
 */

import { describe, it, expect } from "vitest";
import { sqliteDialect, postgresDialect } from "../../src/dbs/index.js";
import { compileWhereExpr } from "../../src/dbs/shared-dialect.js";
import type { Expr } from "../../src/orm/expr.js";
import { col, konst, selectPlan, countPostsSelect } from "./subquery-ref-helpers.js";

const correlatedPostCount = selectPlan({
  selectItems: countPostsSelect,
  where: { kind: "binary", op: "===", left: col("t1", "authorId"), right: col("t0", "id") },
});

describe("Aggregate subquery comparison in WHERE", () => {
  it("SQLite: subquery on the left of `>`", () => {
    const expr: Expr = {
      kind: "binary",
      op: ">",
      left: { kind: "subquery", plan: correlatedPostCount },
      right: konst(5),
    };
    const result = compileWhereExpr(expr, sqliteDialect);
    expect(result.sql).toBe(
      `((SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) > ?)`,
    );
    expect(result.params).toEqual([5]);
  });

  it("PostgreSQL: same shape with $1", () => {
    const expr: Expr = {
      kind: "binary",
      op: ">",
      left: { kind: "subquery", plan: correlatedPostCount },
      right: konst(5),
    };
    const result = compileWhereExpr(expr, postgresDialect);
    expect(result.sql).toBe(
      `((SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) > $1)`,
    );
    expect(result.params).toEqual([5]);
  });

  it("subquery on the right side of comparison", () => {
    const expr: Expr = {
      kind: "binary",
      op: "<",
      left: konst(10),
      right: { kind: "subquery", plan: correlatedPostCount },
    };
    const result = compileWhereExpr(expr, sqliteDialect);
    expect(result.sql).toBe(
      `(? < (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")))`,
    );
    expect(result.params).toEqual([10]);
  });

  it("non-correlated subquery comparison (no innerParamNames)", () => {
    const sub = selectPlan({
      selectItems: countPostsSelect,
      where: null,
    });
    const expr: Expr = {
      kind: "binary",
      op: ">=",
      left: { kind: "subquery", plan: sub },
      right: konst(1),
    };
    const result = compileWhereExpr(expr, postgresDialect);
    expect(result.sql).toBe(`((SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1) >= $1)`);
    expect(result.params).toEqual([1]);
  });
});
