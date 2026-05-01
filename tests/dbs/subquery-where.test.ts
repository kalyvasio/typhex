/**
 * Unit tests for using a scalar (aggregate) subquery on either side of a
 * binary comparison in a WHERE / HAVING clause.
 */

import { describe, it, expect } from "vitest";
import { sqliteDialect, postgresDialect } from "../../src/dbs/index.js";
import type { IrBinary, IrSubquery } from "../../src/ir/types.js";

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

describe("Aggregate subquery comparison in WHERE", () => {
  it("SQLite: subquery on the left of `>`", () => {
    const ir: IrBinary = {
      kind: "binary",
      op: ">",
      left: correlatedPostCount,
      right: { kind: "const", value: 5 },
    };
    const result = sqliteDialect.compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `((SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) > ?)`,
    );
    expect(result.params).toEqual([5]);
  });

  it("PostgreSQL: same shape with $1", () => {
    const ir: IrBinary = {
      kind: "binary",
      op: ">",
      left: correlatedPostCount,
      right: { kind: "const", value: 5 },
    };
    const result = postgresDialect.compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `((SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) > $1)`,
    );
    expect(result.params).toEqual([5]);
  });

  it("subquery on the right side of comparison", () => {
    const ir: IrBinary = {
      kind: "binary",
      op: "<",
      left: { kind: "const", value: 10 },
      right: correlatedPostCount,
    };
    const result = sqliteDialect.compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `(? < (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")))`,
    );
    expect(result.params).toEqual([10]);
  });

  it("non-correlated subquery comparison (no innerParamNames)", () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      aggregate: { func: "COUNT" },
      whereIr: null,
      whereParams: {},
    };
    const ir: IrBinary = {
      kind: "binary",
      op: ">=",
      left: sub,
      right: { kind: "const", value: 1 },
    };
    const result = postgresDialect.compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(`((SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1) >= $1)`);
    expect(result.params).toEqual([1]);
  });
});
