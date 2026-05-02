import { describe, it, expect } from "vitest";
import {
  isIrNode,
  isIrSelect,
  isIrOrderBy,
  type IrBinary,
  type IrMember,
  type IrConst,
  type IrParam,
  type IrUnary,
  type IrIn,
  type IrCall,
  type IrSelect,
  type IrOrderBy,
} from "../../src/ir/types.js";

describe("ir/types", () => {
  describe("isIrNode", () => {
    it("returns true for binary node", () => {
      const node: IrBinary = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 18 },
      };
      expect(isIrNode(node)).toBe(true);
    });

    it("returns true for unary node", () => {
      const node: IrUnary = {
        kind: "unary",
        op: "!",
        operand: { kind: "const", value: false },
      };
      expect(isIrNode(node)).toBe(true);
    });

    it("returns true for member node", () => {
      const node: IrMember = { kind: "member", param: "u", path: ["id"] };
      expect(isIrNode(node)).toBe(true);
    });

    it("returns true for const node", () => {
      const node: IrConst = { kind: "const", value: 42 };
      expect(isIrNode(node)).toBe(true);
    });

    it("returns true for param node", () => {
      const node: IrParam = { kind: "param", key: "x" };
      expect(isIrNode(node)).toBe(true);
    });

    it("returns true for in node", () => {
      const node: IrIn = {
        kind: "in",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: [1, 2, 3] },
      };
      expect(isIrNode(node)).toBe(true);
    });

    it("returns true for call node", () => {
      const node: IrCall = {
        kind: "call",
        method: "startsWith",
        receiver: { kind: "member", param: "u", path: ["name"] },
        args: [{ kind: "const", value: "A" }],
      };
      expect(isIrNode(node)).toBe(true);
    });

    it("returns false for null", () => {
      expect(isIrNode(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isIrNode(undefined)).toBe(false);
    });

    it("returns false for non-object", () => {
      expect(isIrNode(42)).toBe(false);
      expect(isIrNode("string")).toBe(false);
    });

    it("returns false for object with unknown kind", () => {
      expect(isIrNode({ kind: "unknown" })).toBe(false);
    });
  });

  describe("isIrSelect", () => {
    it("returns true for valid IrSelect with paths", () => {
      const sel: IrSelect = { param: "u", paths: [["id"], ["name"]] };
      expect(isIrSelect(sel)).toBe(true);
    });

    it("returns true for IrSelect with aliases", () => {
      const sel: IrSelect = {
        param: "u",
        paths: [["id"], ["name"]],
        aliases: ["userId", "userName"],
      };
      expect(isIrSelect(sel)).toBe(true);
    });

    it("returns true for IrSelect with rest", () => {
      const sel: IrSelect = { param: "u", paths: [["id"]], rest: true };
      expect(isIrSelect(sel)).toBe(true);
    });

    it("returns true for IrSelect with empty paths and rest", () => {
      const sel: IrSelect = { param: "u", paths: [], rest: true };
      expect(isIrSelect(sel)).toBe(true);
    });

    it("returns true for IrSelect with empty paths (select all)", () => {
      const sel: IrSelect = { param: "u", paths: [] };
      expect(isIrSelect(sel)).toBe(true);
    });

    it("returns false for null", () => {
      expect(isIrSelect(null)).toBe(false);
    });

    it("returns false for non-object", () => {
      expect(isIrSelect(42)).toBe(false);
    });

    it("returns false when param is not a string", () => {
      expect(isIrSelect({ param: 1, paths: [] })).toBe(false);
    });

    it("returns false when paths is not an array", () => {
      expect(isIrSelect({ param: "u", paths: "id" })).toBe(false);
    });

    it("returns false when rest is not boolean", () => {
      expect(isIrSelect({ param: "u", paths: [], rest: "yes" })).toBe(false);
    });
  });

  describe("isIrOrderBy", () => {
    it("returns true for a valid IrOrderBy", () => {
      const ob: IrOrderBy = { expr: { kind: "member", param: "u", path: ["name"] }, direction: "asc" };
      expect(isIrOrderBy(ob)).toBe(true);
    });

    it("returns true for desc direction", () => {
      expect(isIrOrderBy({ expr: { kind: "member", param: "u", path: ["age"] }, direction: "desc" })).toBe(true);
    });

    it("returns true for a relation path", () => {
      expect(isIrOrderBy({ expr: { kind: "member", param: "u", path: ["author", "name"] }, direction: "asc" })).toBe(true);
    });

    it("returns true for a subquery expr", () => {
      expect(
        isIrOrderBy({
          expr: {
            kind: "subquery",
            tableName: "posts",
            selectIr: { param: "p", paths: [], aggregates: [{ kind: "aggregate", func: "COUNT", arg: null }] },
            whereIr: null,
            whereParams: {},
          },
          direction: "asc",
        }),
      ).toBe(true);
    });

    it("returns false when expr is missing", () => {
      expect(isIrOrderBy({ direction: "asc" })).toBe(false);
    });

    it("returns false when expr is not an IR node", () => {
      expect(isIrOrderBy({ expr: { kind: "bogus" }, direction: "asc" })).toBe(false);
    });

    it("returns false for unknown direction", () => {
      expect(isIrOrderBy({ expr: { kind: "member", param: "u", path: ["name"] }, direction: "random" })).toBe(false);
    });

    it("returns false for null", () => {
      expect(isIrOrderBy(null)).toBe(false);
    });

    it("returns false for non-object", () => {
      expect(isIrOrderBy("asc")).toBe(false);
    });
  });
});
