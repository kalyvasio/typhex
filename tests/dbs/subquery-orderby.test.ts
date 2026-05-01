/**
 * Unit tests for scalar subqueries used as ORDER BY sort keys.
 */

import { describe, it, expect } from "vitest";
import { sqliteDialect, postgresDialect } from "../../src/dbs/index.js";
import type { IrOrderBy, IrSubquery } from "../../src/ir/types.js";

const correlatedPostCount: IrSubquery = {
  kind: "subquery",
  tableName: "posts",
  aggregate: { func: "COUNT" },
  whereIr: {
    kind: "binary",
    op: "===",
    left: { kind: "member", param: "p", path: ["authorId"] },
    right: { kind: "member", param: "a", path: ["id"] },
  },
  whereParams: {},
  innerParamNames: ["p"],
};

describe("ORDER BY subquery", () => {
  it("SQLite: emits subquery as sort key (correlated COUNT)", () => {
    const orders: IrOrderBy[] = [{ expr: correlatedPostCount, direction: "desc" }];
    const { sql, params } = sqliteDialect.compileOrderBy(orders, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) DESC`,
    );
    expect(params).toEqual([]);
  });

  it("PostgreSQL: literal predicate uses placeholder, sort key threads params", () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      aggregate: { func: "COUNT" },
      whereIr: {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "p", path: ["active"] },
        right: { kind: "const", value: true },
      },
      whereParams: {},
      innerParamNames: ["p"],
    };
    const orders: IrOrderBy[] = [{ expr: sub, direction: "asc" }];
    const { sql, params } = postgresDialect.compileOrderBy(orders, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."active" = $1)) ASC`,
    );
    expect(params).toEqual([true]);
  });

  it("mixes member sort key with subquery sort key", () => {
    const orders: IrOrderBy[] = [
      { expr: { kind: "member", param: "a", path: ["name"] }, direction: "asc" },
      { expr: correlatedPostCount, direction: "desc" },
    ];
    const { sql, params } = sqliteDialect.compileOrderBy(orders, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `"t0"."name" ASC, (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) DESC`,
    );
    expect(params).toEqual([]);
  });
});
