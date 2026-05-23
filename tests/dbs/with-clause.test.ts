import { describe, it, expect } from "vitest";
import { postgresQueryCompiler } from "../../src/dbs/postgres/query-compiler.js";
import { sqliteQueryCompiler } from "../../src/dbs/sqlite/query-compiler.js";

describe("compileWithClause", () => {
  it("Postgres: merges CTE params before outer params and renumbers placeholders", () => {
    const { sql, params } = postgresQueryCompiler["compileWithClause"](
      `SELECT $1 FROM "users" AS t0 WHERE "t0"."id" = $2`,
      [1, 2],
      [{ name: "a", bodySql: `SELECT $1 AS x FROM "users" AS t0 WHERE "t0"."age" >= $2`, bodyParams: [21, 22] }],
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
      [{ name: "a", bodySql: `SELECT ? FROM "users" AS t0 WHERE "t0"."age" >= ?`, bodyParams: [21, 22] }],
    );
    expect(sql.startsWith(`WITH "a" AS (`)).toBe(true);
    expect(params).toEqual([21, 22, 1, 2]);
  });
});
