import { describe, expect, it } from "vitest";
import { postgresQueryCompiler, sqliteQueryCompiler } from "../../src/dbs/index.js";
import type { Expr, ExprAggregate, SelectItem } from "../../src/orm/expr.js";
import { col, eq, konst, selectPlan, countPostsSelect, bin } from "./subquery-ref-helpers.js";

const correlatedActivePosts = selectPlan({
  selectItems: countPostsSelect,
  where: eq(col("t1", "authorId"), col("t0", "id")),
});

describe("Correlated scalar subquery in SELECT", () => {
  it("SQLite: outer param ref resolves to outer table alias", () => {
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: correlatedActivePosts }, alias: "postCount" },
    ];
    const { sql, params } = sqliteQueryCompiler.compileSelectListExpr(items, false, "t0", [
      "id",
      "name",
    ]);
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) AS "postCount"`,
    );
    expect(params).toEqual([]);
  });

  it("PostgreSQL: same shape with $-style placeholders absent", () => {
    const items: SelectItem[] = [
      { expr: col("t0", "name"), alias: "name" },
      { expr: { kind: "subquery", plan: correlatedActivePosts }, alias: "postCount" },
    ];
    const { sql, params } = postgresQueryCompiler.compileSelectListExpr(items, false, "t0", [
      "id",
      "name",
    ]);
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) AS "postCount"`,
    );
    expect(params).toEqual([]);
  });

  it("correlated SUM with literal predicate mixes outer ref and bind param", () => {
    const sumAgg: ExprAggregate = {
      kind: "aggregate",
      func: "SUM",
      arg: col("t1", "score"),
    };
    const sumPlan = selectPlan({
      selectItems: [{ expr: sumAgg }],
      where: bin(
        "&&",
        eq(col("t1", "authorId"), col("t0", "id")),
        eq(col("t1", "active"), konst(true)),
      ),
    });
    const items: SelectItem[] = [{ expr: { kind: "subquery", plan: sumPlan }, alias: "score" }];
    const { sql, params } = postgresQueryCompiler.compileSelectListExpr(items, false, "t0", [
      "id",
      "name",
    ]);
    expect(sql).toBe(
      `(SELECT SUM("t1"."score") FROM "posts" AS "t1" WHERE (("t1"."authorId" = "t0"."id") AND ("t1"."active" = $1))) AS "score"`,
    );
    expect(params).toEqual([true]);
  });
});

describe("Correlated scalar subquery from destructured outer arrow", () => {
  it("destructured `id` resolves to the outer row, matching the non-destructured shape", () => {
    const sub = selectPlan({
      selectItems: countPostsSelect,
      where: eq(col("t1", "authorId"), col("t0", "id")),
    });
    const items: SelectItem[] = [{ expr: { kind: "subquery", plan: sub }, alias: "c" }];
    const { sql, params } = sqliteQueryCompiler.compileSelectListExpr(items, false, "t0", [
      "id",
      "name",
    ]);
    expect(sql).toBe(
      `(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) AS "c"`,
    );
    expect(params).toEqual([]);
  });
});

describe("Correlated IN subquery", () => {
  it("compiles correlated WHERE IN with outer param reference", () => {
    const sub = selectPlan({
      selectItems: [{ expr: col("t1", "authorId") }],
      where: eq(col("t1", "category"), col("t0", "preferredCategory")),
    });
    const expr: Expr = {
      kind: "in",
      left: col("t0", "id"),
      right: { kind: "subquery", plan: sub },
    };
    const result = sqliteQueryCompiler.compileWhereExpr(expr);
    expect(result.sql).toBe(
      `"t0"."id" IN (SELECT "t1"."authorId" FROM "posts" AS "t1" WHERE ("t1"."category" = "t0"."preferredCategory"))`,
    );
    expect(result.params).toEqual([]);
  });
});
