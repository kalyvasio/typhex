import { describe, it, expect } from "vitest";
import {
  isIrNode,
  type IrNode,
  type IrBinary,
  type IrMember,
  type IrConst,
  type IrParam,
  type IrUnary,
  type IrIn,
  type IrCall,
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
});
