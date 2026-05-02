/**
 * Unit tests for correlated scalar subqueries: subqueries whose inner WHERE
 * references the outer query's row params.
 */

import { describe, it, expect } from "vitest";
import { sqliteDialect, postgresDialect } from "../../src/dbs/index.js";
import type { IrSelect, IrSubquery, IrIn } from "../../src/ir/types.js";

/** posts where authorId === a.id — `a` is an outer row param. */
const correlatedActivePosts: IrSubquery = {
  kind: "subquery",
  tableName: "posts",
  selectIr: {
    param: "p",
    paths: [],
    aggregates: [{ kind: "aggregate", func: "COUNT", arg: null }],
  },
  whereIr: {
    kind: "binary",
    op: "===",
    left: { kind: "member", param: "p", path: ["authorId"] },
    right: { kind: "member", param: "a", path: ["id"] },
  },
  whereParams: {},
  innerParamNames: ["p"],
};

describe("Correlated scalar subquery in SELECT", () => {
  it("SQLite: outer param ref resolves to outer table alias", () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [{ alias: "postCount", subquery: correlatedActivePosts }],
    };
    const { sql, params } = sqliteDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) AS "postCount"`,
    );
    expect(params).toEqual([]);
  });

  it("PostgreSQL: same shape with $-style placeholders absent (no literals)", () => {
    const select: IrSelect = {
      param: "a",
      paths: [["name"]],
      aliases: ["name"],
      subqueries: [{ alias: "postCount", subquery: correlatedActivePosts }],
    };
    const { sql, params } = postgresDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `"t0"."name" AS "name", (SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) AS "postCount"`,
    );
    expect(params).toEqual([]);
  });

  it("correlated SUM with literal predicate mixes outer ref and bind param", () => {
    const sumActivePostsForAuthor: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectIr: {
        param: "p",
        paths: [],
        aggregates: [
          {
            kind: "aggregate",
            func: "SUM",
            arg: { kind: "member", param: "p", path: ["score"] },
          },
        ],
      },
      whereIr: {
        kind: "binary",
        op: "&&",
        left: {
          kind: "binary",
          op: "===",
          left: { kind: "member", param: "p", path: ["authorId"] },
          right: { kind: "member", param: "a", path: ["id"] },
        },
        right: {
          kind: "binary",
          op: "===",
          left: { kind: "member", param: "p", path: ["active"] },
          right: { kind: "const", value: true },
        },
      },
      whereParams: {},
      innerParamNames: ["p"],
    };
    const select: IrSelect = {
      param: "a",
      paths: [],
      subqueries: [{ alias: "score", subquery: sumActivePostsForAuthor }],
    };
    const { sql, params } = postgresDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { a: "t0" },
    });
    expect(sql).toBe(
      `(SELECT SUM("t1"."score") FROM "posts" AS "t1" WHERE (("t1"."authorId" = "t0"."id") AND ("t1"."active" = $1))) AS "score"`,
    );
    expect(params).toEqual([true]);
  });
});

describe("Correlated scalar subquery from destructured outer arrow", () => {
  it("destructured `id` resolves to the outer row, matching the non-destructured shape", () => {
    // Shape produced by the transformer when the outer select-arrow is
    // `({ id }) => ({ c: Post.query().where(p => p.authorId === id).count() })`.
    // The destructured local `id` is plumbed to IrMember{ param: "u", path: ["id"] }.
    const sub: IrSubquery = {
      kind: "subquery",
      tableName: "posts",
      selectIr: {
        param: "p",
        paths: [],
        aggregates: [{ kind: "aggregate", func: "COUNT", arg: null }],
      },
      whereIr: {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "p", path: ["authorId"] },
        right: { kind: "member", param: "u", path: ["id"] },
      },
      whereParams: {},
      innerParamNames: ["p"],
    };
    const select: IrSelect = {
      param: "u",
      paths: [],
      subqueries: [{ alias: "c", subquery: sub }],
    };
    const { sql, params } = sqliteDialect.compileSelectList(select, ["id", "name"], {
      tableAlias: "t0",
      paramToAlias: { u: "t0" },
    });
    expect(sql).toBe(
      `(SELECT COUNT(*) FROM "posts" AS "t1" WHERE ("t1"."authorId" = "t0"."id")) AS "c"`,
    );
    expect(params).toEqual([]);
  });
});

describe("Correlated IN subquery", () => {
  it("compiles correlated WHERE IN with outer param reference", () => {
    const correlatedIn: IrIn = {
      kind: "in",
      left: { kind: "member", param: "u", path: ["id"] },
      right: {
        kind: "subquery",
        tableName: "posts",
        selectIr: { param: "p", paths: [["authorId"]] },
        whereIr: {
          kind: "binary",
          op: "===",
          left: { kind: "member", param: "p", path: ["category"] },
          right: { kind: "member", param: "u", path: ["preferredCategory"] },
        },
        whereParams: {},
        innerParamNames: ["p"],
      },
    };
    const dialect = sqliteDialect;
    const result = dialect.compileWhere(correlatedIn, {
      tableAlias: "t0",
      paramToAlias: { u: "t0" },
    });
    expect(result.sql).toBe(
      `"t0"."id" IN (SELECT "t1"."authorId" FROM "posts" AS "t1" WHERE ("t1"."category" = "t0"."preferredCategory"))`,
    );
    expect(result.params).toEqual([]);
  });
});
