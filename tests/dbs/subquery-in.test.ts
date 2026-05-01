/**
 * Unit tests for WHERE IN subquery IR compilation (SQLite and PostgreSQL dialects).
 */

import { describe, it, expect } from "vitest";
import { getDialect } from "../../src/dbs/index.js";
import type { IrIn } from "../../src/ir/types.js";
import type { IrSubquery } from "../../src/ir/types.js";

describe("IrSubquery compilation", () => {
  const subquery: IrSubquery = {
    kind: "subquery",
    tableName: "posts",
    selectCol: "id",
    whereIr: {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "p", path: ["active"] },
      right: { kind: "const", value: true },
    },
    whereParams: {},
  };

  const ir: IrIn = {
    kind: "in",
    left: { kind: "member", param: "a", path: ["postId"] },
    right: subquery,
  };

  it("SQLite: compiles IN subquery correctly", () => {
    const dialect = getDialect("sqlite");
    const result = dialect.compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE ("t1"."active" = ?))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("PostgreSQL: compiles IN subquery correctly", () => {
    const dialect = getDialect("postgres");
    const result = dialect.compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE ("t1"."active" = $1))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("SQLite: compiles NOT IN subquery correctly (negated)", () => {
    const negatedIr: IrIn = { ...ir, negated: true };
    const dialect = getDialect("sqlite");
    const result = dialect.compileWhere(negatedIr, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `"t0"."postId" NOT IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE ("t1"."active" = ?))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("avoids alias collision when outer query already uses t1 (e.g. via JOIN)", () => {
    // Outer query has a JOIN that occupies t1 — subquery must pick t2.
    const dialect = getDialect("sqlite");
    const result = dialect.compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
      relationPathToAlias: { "a.posts": "t1" },
    });
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t2"."id" FROM "posts" AS "t2" WHERE ("t2"."active" = ?))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("supports a custom outer param name (no u/p/e/t heuristic)", () => {
    // Subquery uses param name `author` rather than the legacy u/p/e/t set.
    const customSubquery: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectCol: "id",
      whereIr: {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "author", path: ["active"] },
        right: { kind: "const", value: true },
      },
      whereParams: {},
    };
    const customIr: IrIn = {
      kind: "in",
      left: { kind: "member", param: "outer", path: ["postId"] },
      right: customSubquery,
    };
    const dialect = getDialect("sqlite");
    const result = dialect.compileWhere(customIr, {
      tableAlias: "t0",
      paramToAlias: { outer: "t0" },
    });
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE ("t1"."active" = ?))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("nested IN subqueries get distinct aliases", () => {
    // a.postId IN (SELECT id FROM posts WHERE authorId IN (SELECT id FROM users WHERE active = true))
    const innerSub: IrSubquery = {
      kind: "subquery",
      tableName: "users",
      selectCol: "id",
      whereIr: {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["active"] },
        right: { kind: "const", value: true },
      },
      whereParams: {},
    };
    const middleSub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectCol: "id",
      whereIr: {
        kind: "in",
        left: { kind: "member", param: "p", path: ["authorId"] },
        right: innerSub,
      },
      whereParams: {},
    };
    const nestedIr: IrIn = {
      kind: "in",
      left: { kind: "member", param: "a", path: ["postId"] },
      right: middleSub,
    };
    const dialect = getDialect("sqlite");
    const result = dialect.compileWhere(nestedIr, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE "t1"."authorId" IN (SELECT "t2"."id" FROM "users" AS "t2" WHERE ("t2"."active" = ?)))`,
    );
    expect(result.params).toEqual([true]);
  });

  it("compiles top-N IN subquery: SELECT col ORDER BY ... LIMIT n", () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectCol: "id",
      whereIr: null,
      whereParams: {},
      orderBy: [{ expr: { kind: "member", param: "p", path: ["score"] }, direction: "desc" }],
      limitNum: 3,
    };
    const ir: IrIn = {
      kind: "in",
      left: { kind: "member", param: "a", path: ["postId"] },
      right: sub,
    };
    const result = getDialect("sqlite").compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE 1=1 ORDER BY "t1"."score" DESC LIMIT 3)`,
    );
    expect(result.params).toEqual([]);
  });

  it("compiles IN subquery with DISTINCT and LIMIT", () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectCol: "authorId",
      whereIr: null,
      whereParams: {},
      distinct: true,
      limitNum: 10,
    };
    const ir: IrIn = {
      kind: "in",
      left: { kind: "member", param: "a", path: ["id"] },
      right: sub,
    };
    const result = getDialect("sqlite").compileWhere(ir, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(
      `"t0"."id" IN (SELECT DISTINCT "t1"."authorId" FROM "posts" AS "t1" WHERE 1=1 LIMIT 10)`,
    );
    expect(result.params).toEqual([]);
  });

  it("compiles subquery with no WHERE (whereIr is null)", () => {
    const noWhereSubquery: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectCol: "id",
      whereIr: null,
      whereParams: {},
    };
    const noWhereIr: IrIn = {
      kind: "in",
      left: { kind: "member", param: "a", path: ["postId"] },
      right: noWhereSubquery,
    };
    const dialect = getDialect("sqlite");
    const result = dialect.compileWhere(noWhereIr, {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(result.sql).toBe(`"t0"."postId" IN (SELECT "t1"."id" FROM "posts" AS "t1" WHERE 1=1)`);
    expect(result.params).toEqual([]);
  });
});
