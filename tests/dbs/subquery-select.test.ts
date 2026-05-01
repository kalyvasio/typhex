/**
 * Unit tests for scalar subquery columns in SELECT lists (sqlite + postgres).
 */

import { describe, it, expect } from "vitest";
import { sqliteDialect, postgresDialect } from "../../src/dbs/index.js";
import type { IrSelect, IrSubquery } from "../../src/ir/types.js";

const countAllPosts: IrSubquery = {
  kind: "subquery",
  tableName: "posts",
  aggregate: { func: "COUNT" },
  whereIr: null,
  whereParams: {},
};

const countActivePosts: IrSubquery = {
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
};

const sumActivePostScores: IrSubquery = {
  kind: "subquery",
  tableName: "posts",
  aggregate: { func: "SUM", valueCol: "score" },
  whereIr: {
    kind: "binary",
    op: "===",
    left: { kind: "member", param: "p", path: ["active"] },
    right: { kind: "const", value: true },
  },
  whereParams: {},
};

describe("Scalar subquery columns in SELECT", () => {
  it('SQLite: emits (SELECT COUNT(*) FROM ...) AS "<alias>" with no params', () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [{ alias: "totalPosts", subquery: countAllPosts }],
    };
    const { sql, params } = sqliteDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1) AS "totalPosts"`,
    );
    expect(params).toEqual([]);
  });

  it("SQLite: subquery with WHERE pushes params and emits placeholders", () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [{ alias: "activePosts", subquery: countActivePosts }],
    };
    const { sql, params } = sqliteDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."active" = ?)) AS "activePosts"`,
    );
    expect(params).toEqual([true]);
  });

  it("PostgreSQL: subquery with WHERE numbers placeholders starting at $1", () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [{ alias: "activePosts", subquery: countActivePosts }],
    };
    const { sql, params } = postgresDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."active" = $1)) AS "activePosts"`,
    );
    expect(params).toEqual([true]);
  });

  it('emits SUM("alias"."col") for non-COUNT aggregates', () => {
    const select: IrSelect = {
      param: "a",
      paths: [],
      subqueries: [{ alias: "totalScore", subquery: sumActivePostScores }],
    };
    const { sql, params } = sqliteDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `(SELECT SUM("t1"."score") FROM "posts" AS "t1" WHERE ("t1"."active" = ?)) AS "totalScore"`,
    );
    expect(params).toEqual([true]);
  });

  it("multiple subquery columns share params in order", () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [
        { alias: "active", subquery: countActivePosts },
        { alias: "totalScore", subquery: sumActivePostScores },
      ],
    };
    const { sql, params } = postgresDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `"t0"."name" AS "name", ` +
        `(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."active" = $1)) AS "active", ` +
        `(SELECT SUM("t1"."score") FROM "posts" AS "t1" WHERE ("t1"."active" = $2)) AS "totalScore"`,
    );
    expect(params).toEqual([true, true]);
  });

  it("subquery alias avoids outer JOIN alias collision", () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [{ alias: "active", subquery: countActivePosts }],
    };
    const { sql } = sqliteDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
      relationPathToAlias: { "a.posts": "t1" },
    });
    expect(sql).toContain(`AS "t2"`);
    expect(sql).not.toMatch(/FROM "posts" AS "t1"/);
  });

  it("regular aggregates and subqueries coexist in select list", () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      aggregates: [{ kind: "aggregate", func: "COUNT", arg: null, alias: "rowCount" }],
      subqueries: [{ alias: "totalPosts", subquery: countAllPosts }],
    };
    const { sql } = sqliteDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `"t0"."name" AS "name", COUNT(*) AS "rowCount", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1) AS "totalPosts"`,
    );
  });

  it("emits LIMIT inside the subquery for COUNT(*) with limitNum", () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      aggregate: { func: "COUNT" },
      whereIr: null,
      whereParams: {},
      limitNum: 10,
    };
    const select: IrSelect = {
      param: "a",
      paths: [],
      subqueries: [{ alias: "c", subquery: sub }],
    };
    const { sql } = sqliteDialect.compileSelectList(select, ["id"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(`(SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1 LIMIT 10) AS "c"`);
  });

  it("emits ORDER BY ... LIMIT for top-N subquery in SELECT", () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      aggregate: { func: "MAX", valueCol: "score" },
      whereIr: null,
      whereParams: {},
      orderBy: [{ expr: { kind: "member", param: "p", path: ["score"] }, direction: "desc" }],
      limitNum: 1,
    };
    const select: IrSelect = {
      param: "a",
      paths: [],
      subqueries: [{ alias: "topScore", subquery: sub }],
    };
    const { sql } = sqliteDialect.compileSelectList(select, ["id"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `(SELECT MAX("t1"."score") FROM "posts" AS "t1" WHERE 1=1 ORDER BY "t1"."score" DESC LIMIT 1) AS "topScore"`,
    );
  });

  it("emits LIMIT and OFFSET inside the subquery", () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      aggregate: { func: "COUNT" },
      whereIr: null,
      whereParams: {},
      limitNum: 5,
      offsetNum: 2,
    };
    const select: IrSelect = {
      param: "a",
      paths: [],
      subqueries: [{ alias: "c", subquery: sub }],
    };
    const { sql } = sqliteDialect.compileSelectList(select, ["id"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(`(SELECT COUNT(*) FROM "posts" AS "t1" WHERE 1=1 LIMIT 5 OFFSET 2) AS "c"`);
  });

  it("emits SUM(DISTINCT col) when distinct.col is set", () => {
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      aggregate: { func: "SUM", valueCol: "score" },
      whereIr: null,
      whereParams: {},
      distinct: { col: "score" },
    };
    const select: IrSelect = {
      param: "a",
      paths: [],
      subqueries: [{ alias: "s", subquery: sub }],
    };
    const { sql } = sqliteDialect.compileSelectList(select, ["id"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(`(SELECT SUM(DISTINCT "t1"."score") FROM "posts" AS "t1" WHERE 1=1) AS "s"`);
  });

  it("throws when SUM subquery is missing valueCol", () => {
    const broken: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      aggregate: { func: "SUM" },
      whereIr: null,
      whereParams: {},
    };
    const select: IrSelect = {
      param: "a",
      paths: [],
      subqueries: [{ alias: "x", subquery: broken }],
    };
    expect(() =>
      sqliteDialect.compileSelectList(select, ["id"], {
        tableAlias: "t0",
        paramToAlias: { a: "t0" },
      }),
    ).toThrow(/SUM subquery requires a column/);
  });
});
