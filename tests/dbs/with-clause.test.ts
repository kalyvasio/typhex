import { describe, it, expect } from "vitest";
import { shiftPostgresPlaceholders, wrapWithPostgres, wrapWithSqlite } from "../../src/dbs/with-clause.js";

describe("with-clause", () => {
  it("shiftPostgresPlaceholders adds delta to each $n", () => {
    expect(shiftPostgresPlaceholders(`SELECT $1, $2 FROM t WHERE $3 > $10`, 5)).toBe(
      `SELECT $6, $7 FROM t WHERE $8 > $15`
    );
  });

  it("wrapWithPostgres merges CTE params before outer params", () => {
    const { sql, params } = wrapWithPostgres(
      `SELECT $1 FROM "users" AS t0 WHERE "t0"."id" = $2`,
      [1, 2],
      [{ name: "a", bodySql: `SELECT $1 AS x FROM "users" AS t0 WHERE "t0"."age" >= $2`, bodyParams: [21, 22] }]
    );
    expect(sql.startsWith(`WITH "a" AS (`)).toBe(true);
    expect(params).toEqual([21, 22, 1, 2]);
    expect(sql).toContain(`SELECT $3 FROM`);
    expect(sql).toContain(`$4`);
  });

  it("wrapWithSqlite concatenates params in order", () => {
    const { sql, params } = wrapWithSqlite(
      `SELECT ? FROM "users" AS t0 WHERE "t0"."id" = ?`,
      [1, 2],
      [{ name: "a", bodySql: `SELECT ? FROM "users" AS t0 WHERE "t0"."age" >= ?`, bodyParams: [21, 22] }]
    );
    expect(sql.startsWith(`WITH "a" AS (`)).toBe(true);
    expect(params).toEqual([21, 22, 1, 2]);
  });
});
