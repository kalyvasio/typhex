import { describe, it, expect } from "vitest";
import { postgresQueryCompiler } from "../../src/dbs/postgres/query-compiler.js";
import { sqliteQueryCompiler } from "../../src/dbs/sqlite/query-compiler.js";

describe("compileWithClause", () => {
  it("Postgres: merges CTE params before outer params and renumbers placeholders", () => {
    const { sql, params } = postgresQueryCompiler["compileWithClause"](
      `SELECT $1 FROM "users" AS t0 WHERE "t0"."id" = $2`,
      [1, 2],
      [{ name: "a", bodySql: `SELECT $1 AS x FROM "users" AS t0 WHERE "t0"."age" >= $2`, bodyParams: [21, 22] }],
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
      [{ name: "a", bodySql: `SELECT ? FROM "users" AS t0 WHERE "t0"."age" >= ?`, bodyParams: [21, 22] }],
      1,
    );
    expect(sql.startsWith(`WITH "a" AS (`)).toBe(true);
    expect(params).toEqual([21, 22, 1, 2]);
  });

  it("Postgres: applies paramStartIndex base offset to all CTE and core placeholders", () => {
    const { sql, params } = postgresQueryCompiler["compileWithClause"](
      `SELECT $1 FROM "users" AS t0 WHERE "t0"."id" = $2`,
      [1, 2],
      [{ name: "a", bodySql: `SELECT $1 AS x FROM "users" AS t0 WHERE "t0"."age" >= $2`, bodyParams: [21, 22] }],
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
});
