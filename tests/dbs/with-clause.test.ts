import { describe, it, expect } from "vitest";
import { postgresQueryCompiler } from "../../src/dbs/postgres/query-compiler.js";
import { sqliteQueryCompiler } from "../../src/dbs/sqlite/query-compiler.js";
import { selectPlan } from "./compiler-plan-fixtures.js";

function filteredPlan(value: number) {
  return selectPlan("users", {
    columnNames: ["id", "age"],
    selectAll: true,
    where: {
      kind: "binary",
      op: ">=",
      left: { kind: "column", alias: "t0", column: ["age"] },
      right: { kind: "const", value },
    },
  });
}

describe("compileWithClause", () => {
  it("Postgres: merges CTE params before outer params and renumbers placeholders", () => {
    const { sql, params } = postgresQueryCompiler["compileWithClause"](
      `SELECT $1 FROM "users" AS t0 WHERE "t0"."id" = $2`,
      [1, 2],
      [
        {
          name: "a",
          bodySql: `SELECT $1 AS x FROM "users" AS t0 WHERE "t0"."age" >= $2`,
          bodyParams: [21, 22],
        },
      ],
      1,
    );
    expect(sql.startsWith(`WITH "a" AS (`)).toBe(true);
    expect(params).toEqual([21, 22, 1, 2]);
    expect(sql).toContain(`SELECT $3 FROM`);
    expect(sql).toContain(`$4`);
  });

  it("SQLite: concatenates params in order", () => {
    const { sql, params } = sqliteQueryCompiler["compileWithClause"](
      `SELECT ? FROM "users" AS t0 WHERE "t0"."id" = ?`,
      [1, 2],
      [
        {
          name: "a",
          bodySql: `SELECT ? FROM "users" AS t0 WHERE "t0"."age" >= ?`,
          bodyParams: [21, 22],
        },
      ],
      1,
    );
    expect(sql.startsWith(`WITH "a" AS (`)).toBe(true);
    expect(params).toEqual([21, 22, 1, 2]);
  });

  it("Postgres: applies paramStartIndex base offset to all CTE and core placeholders", () => {
    const { sql, params } = postgresQueryCompiler["compileWithClause"](
      `SELECT $1 FROM "users" AS t0 WHERE "t0"."id" = $2`,
      [1, 2],
      [
        {
          name: "a",
          bodySql: `SELECT $1 AS x FROM "users" AS t0 WHERE "t0"."age" >= $2`,
          bodyParams: [21, 22],
        },
      ],
      5,
    );
    expect(params).toEqual([21, 22, 1, 2]);
    expect(sql).toContain(`SELECT $7 FROM`);
    expect(sql).toContain(`$8`);
    expect(sql).toContain(`"t0"."age" >= $6`);
  });

  it("Postgres: uses WITH RECURSIVE when a clause is recursive", () => {
    const { sql } = postgresQueryCompiler["compileWithClause"](
      `SELECT 1`,
      [],
      [{ name: "tree", bodySql: `SELECT 1`, bodyParams: [], recursive: true }],
      1,
    );
    expect(sql.startsWith("WITH RECURSIVE")).toBe(true);
  });

  it("SQLite: uses WITH RECURSIVE when a clause is recursive", () => {
    const { sql } = sqliteQueryCompiler["compileWithClause"](
      `SELECT 1`,
      [],
      [{ name: "tree", bodySql: `SELECT 1`, bodyParams: [], recursive: true }],
      1,
    );
    expect(sql.startsWith("WITH RECURSIVE")).toBe(true);
  });

  it.each([
    ["Postgres", postgresQueryCompiler, "$1", "$2"],
    ["SQLite", sqliteQueryCompiler, "?", "?"],
  ] as const)(
    "%s: compiles plan-valued CTE bodies with CTE params first",
    (_dialect, compiler, innerPlaceholder, outerPlaceholder) => {
      const plan = {
        ...filteredPlan(65),
        ctes: [{ name: "adults", kind: "simple" as const, plan: filteredPlan(21) }],
        fromSource: { kind: "cte" as const, name: "adults" },
      };

      const { sql, params } = compiler.compilePlan(plan);

      expect(params).toEqual([21, 65]);
      expect(sql).toContain(`"t0"."age" >= ${innerPlaceholder}`);
      expect(sql).toContain(`FROM "adults" AS "t0"`);
      expect(sql).toContain(`"t0"."age" >= ${outerPlaceholder}`);
    },
  );

  it.each([
    ["Postgres", postgresQueryCompiler, "$1", "$2"],
    ["SQLite", sqliteQueryCompiler, "?", "?"],
  ] as const)(
    "%s: compiles plan-valued inline FROM subqueries before outer params",
    (_dialect, compiler, innerPlaceholder, outerPlaceholder) => {
      const plan = {
        ...filteredPlan(65),
        fromSource: { kind: "subquery" as const, plan: filteredPlan(21) },
      };

      const { sql, params } = compiler.compilePlan(plan);

      expect(params).toEqual([21, 65]);
      expect(sql).toContain(`FROM (SELECT`);
      expect(sql).toContain(`"t0"."age" >= ${innerPlaceholder}`);
      expect(sql).toContain(`"t0"."age" >= ${outerPlaceholder}`);
    },
  );
});
