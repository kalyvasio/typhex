import { describe, it, expect } from "vitest";
import {
  compileWhere,
  compileOrderBy,
  compileSelectList,
  bindParams,
  expandInParams,
  isParamSentinel,
} from "../../src/compiler/sql.js";
import type { IrNode, IrSelect, IrOrderBy } from "../../src/ir/types.js";

describe("compiler/sql", () => {
  const opts = { tableAlias: "t0", paramToAlias: { u: "t0" } };

  describe("compileWhere", () => {
    it("returns 1=1 for null", () => {
      const r = compileWhere(null, opts);
      expect(r.sql).toBe("1=1");
      expect(r.params).toEqual([]);
    });

    it("compiles binary eq", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 18 },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toBe("(\"t0\".\"age\" = ?)");
      expect(r.params).toEqual([18]);
    });

    it("compiles binary and", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "&&",
        left: {
          kind: "binary",
          op: ">=",
          left: { kind: "member", param: "u", path: ["age"] },
          right: { kind: "const", value: 18 },
        },
        right: {
          kind: "binary",
          op: "<=",
          left: { kind: "member", param: "u", path: ["age"] },
          right: { kind: "const", value: 65 },
        },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("AND");
      expect(r.params).toEqual([18, 65]);
    });

    it("compiles binary or", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "||",
        left: { kind: "member", param: "u", path: ["a"] },
        right: { kind: "member", param: "u", path: ["b"] },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("OR");
    });

    it("compiles == as SQL =", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "==",
        left: { kind: "member", param: "u", path: ["x"] },
        right: { kind: "const", value: 1 },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("=");
    });

    it("compiles != as SQL <>", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "!=",
        left: { kind: "member", param: "u", path: ["x"] },
        right: { kind: "const", value: 0 },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("<>");
    });

    it("compiles unary not", () => {
      const ir: IrNode = {
        kind: "unary",
        op: "!",
        operand: {
          kind: "binary",
          op: "===",
          left: { kind: "member", param: "u", path: ["active"] },
          right: { kind: "const", value: true },
        },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("NOT");
      expect(r.params).toEqual([true]);
    });

    it("compiles param placeholder", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["country"] },
        right: { kind: "param", key: "country" },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toBe("(\"t0\".\"country\" = ?)");
      expect(r.params).toEqual([{ __param: "country" }]);
    });

    it("compiles in with const array", () => {
      const ir: IrNode = {
        kind: "in",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: [1, 2, 3] },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("IN");
      expect(r.params).toEqual([1, 2, 3]);
    });

    it("compiles call startsWith", () => {
      const ir: IrNode = {
        kind: "call",
        method: "startsWith",
        receiver: { kind: "member", param: "u", path: ["name"] },
        args: [{ kind: "const", value: "A" }],
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("LIKE");
      expect(r.params).toEqual(["A"]);
    });

    it("compiles call includes", () => {
      const ir: IrNode = {
        kind: "call",
        method: "includes",
        receiver: { kind: "member", param: "u", path: ["name"] },
        args: [{ kind: "const", value: "al" }],
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("LIKE");
      expect(r.params).toEqual(["al"]);
    });

    it("compiles call endsWith", () => {
      const ir: IrNode = {
        kind: "call",
        method: "endsWith",
        receiver: { kind: "member", param: "u", path: ["name"] },
        args: [{ kind: "const", value: "x" }],
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("LIKE");
    });

    it("compiles in with empty array as 1=0", () => {
      const ir: IrNode = {
        kind: "in",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: [] },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toBe("1=0");
      expect(r.params).toEqual([]);
    });

    it("compiles member with nested path", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["profile", "name"] },
        right: { kind: "const", value: "x" },
      };
      const r = compileWhere(ir, opts);
      expect(r.sql).toContain("profile");
    });
  });

  describe("compileOrderBy", () => {
    it("returns empty for empty array", () => {
      expect(compileOrderBy([], opts)).toBe("");
    });

    it("compiles single order by asc", () => {
      const orderBy: IrOrderBy[] = [{ param: "u", path: ["name"], direction: "asc" }];
      expect(compileOrderBy(orderBy, opts)).toBe("\"t0\".\"name\" ASC");
    });

    it("compiles single order by desc", () => {
      const orderBy: IrOrderBy[] = [{ param: "u", path: ["age"], direction: "desc" }];
      expect(compileOrderBy(orderBy, opts)).toBe("\"t0\".\"age\" DESC");
    });
  });

  describe("compileSelectList", () => {
    it("returns all columns when select is null", () => {
      const cols = ["id", "name", "age"];
      expect(compileSelectList(null, cols, opts)).toBe(
        "\"t0\".\"id\", \"t0\".\"name\", \"t0\".\"age\""
      );
    });

    it("returns all columns when paths empty", () => {
      const select: IrSelect = { param: "u", paths: [] };
      const cols = ["id", "name"];
      expect(compileSelectList(select, cols, opts)).toBe("\"t0\".\"id\", \"t0\".\"name\"");
    });

    it("returns selected paths", () => {
      const select: IrSelect = { param: "u", paths: [["id"], ["name"]] };
      const cols = ["id", "name", "age"];
      expect(compileSelectList(select, cols, opts)).toBe("\"t0\".\"id\", \"t0\".\"name\"");
    });

    it("with rest: explicit paths then remaining columns", () => {
      const select: IrSelect = { param: "u", paths: [["id"]], aliases: ["id"], rest: true };
      const cols = ["id", "name", "age"];
      expect(compileSelectList(select, cols, opts)).toBe(
        "\"t0\".\"id\" AS \"id\", \"t0\".\"name\", \"t0\".\"age\""
      );
    });

    it("with rest and empty paths: all columns", () => {
      const select: IrSelect = { param: "u", paths: [], rest: true };
      const cols = ["id", "name"];
      expect(compileSelectList(select, cols, opts)).toBe("\"t0\".\"id\", \"t0\".\"name\"");
    });
  });

  describe("isParamSentinel", () => {
    it("returns true for __param object", () => {
      expect(isParamSentinel({ __param: "x" })).toBe(true);
    });

    it("returns false for null", () => {
      expect(isParamSentinel(null)).toBe(false);
    });

    it("returns false for object without __param", () => {
      expect(isParamSentinel({})).toBe(false);
    });
  });

  describe("bindParams", () => {
    it("replaces param sentinels with values", () => {
      const result = { sql: "?", params: [{ __param: "x" }] };
      expect(bindParams(result, { x: 42 })).toEqual([42]);
    });

    it("expands array params", () => {
      const result = { sql: "?", params: [{ __param: "ids" }] };
      expect(bindParams(result, { ids: [1, 2, 3] })).toEqual([1, 2, 3]);
    });

    it("leaves non-sentinel params as-is", () => {
      const result = { sql: "? ?", params: [10, { __param: "y" }] };
      expect(bindParams(result, { y: 20 })).toEqual([10, 20]);
    });
  });

  describe("compileWhere unknown node", () => {
    it("throws for unknown IR kind", () => {
      const badNode = { kind: "unknown" } as unknown as IrNode;
      expect(() => compileWhere(badNode, opts)).toThrow("Unknown IR node");
    });
  });

  describe("expandInParams", () => {
    it("expands array into multiple placeholders", () => {
      const sql = "(\"t0\".\"id\" IN (?, ?, ?))";
      const params = [1, 2, 3];
      const paramValues = {};
      const r = expandInParams(sql, params, paramValues);
      expect(r.params).toEqual([1, 2, 3]);
      expect(r.sql).toBe("(\"t0\".\"id\" IN (?, ?, ?))");
    });

    it("replaces param sentinel with array expansion", () => {
      const sql = "(\"t0\".\"id\" IN (?))";
      const params = [{ __param: "ids" }];
      const paramValues = { ids: [10, 20] };
      const r = expandInParams(sql, params, paramValues);
      expect(r.sql).toBe("(\"t0\".\"id\" IN (?, ?))");
      expect(r.params).toEqual([10, 20]);
    });
  });
});
