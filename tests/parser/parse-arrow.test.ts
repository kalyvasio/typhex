import { describe, it, expect } from "vitest";
import { parseArrowToIr, parseArrowToIrSelect } from "../../src/parser/parse-arrow.js";

describe("parser/parse-arrow", () => {
  it("parses simple comparison", () => {
    const fn = (u: { age: number }) => u.age > 18;
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("binary");
    if (ir.kind === "binary") {
      expect(ir.op).toBe(">");
      expect(ir.left).toEqual({ kind: "member", param: "u", path: ["age"] });
      expect(ir.right).toEqual({ kind: "const", value: 18 });
    }
  });

  it("parses equality with string", () => {
    const fn = (u: { name: string }) => u.name === "Alice";
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("binary");
    if (ir.kind === "binary") {
      expect(ir.op).toBe("===");
      expect(ir.right).toEqual({ kind: "const", value: "Alice" });
    }
  });

  it("parses and expression", () => {
    const fn = (u: { age: number; active: boolean }) => u.age >= 18 && u.active;
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("binary");
    if (ir.kind === "binary") {
      expect(ir.op).toBe("&&");
    }
  });

  it("parses param (closure variable)", () => {
    const min = 10;
    const fn = (u: { age: number }) => u.age >= min;
    const ir = parseArrowToIr(fn, { paramName: "u", paramKeys: ["min"] });
    expect(ir.kind).toBe("binary");
    if (ir.kind === "binary") {
      expect(ir.right).toEqual({ kind: "param", key: "min" });
    }
  });

  it("parses not expression", () => {
    const fn = (u: { active: boolean }) => !u.active;
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("unary");
    if (ir.kind === "unary") {
      expect(ir.op).toBe("!");
    }
  });

  it("parses in operator with array", () => {
    const fn = (u: { id: number }) => u.id in [1, 2, 3];
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("in");
    if (ir.kind === "in") {
      expect(ir.left).toEqual({ kind: "member", param: "u", path: ["id"] });
      expect(ir.right).toEqual({ kind: "const", value: [1, 2, 3] });
    }
  });

  it("parses startsWith call", () => {
    const fn = (u: { name: string }) => u.name.startsWith("A");
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("call");
    if (ir.kind === "call") {
      expect(ir.method).toBe("startsWith");
      expect(ir.args).toEqual([{ kind: "const", value: "A" }]);
    }
  });

  it("parses includes call", () => {
    const fn = (u: { name: string }) => u.name.includes("al");
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("call");
    if (ir.kind === "call") {
      expect(ir.method).toBe("includes");
    }
  });

  it("parses endsWith call", () => {
    const fn = (u: { name: string }) => u.name.endsWith("y");
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("call");
    if (ir.kind === "call") {
      expect(ir.method).toBe("endsWith");
    }
  });

  it("parses or expression", () => {
    const fn = (u: { a: boolean; b: boolean }) => u.a || u.b;
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("binary");
    if (ir.kind === "binary") {
      expect(ir.op).toBe("||");
    }
  });

  it("infers param name from single param", () => {
    const fn = (x: { n: number }) => x.n > 0;
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("binary");
    if (ir.kind === "binary") {
      expect((ir.left as { param?: string }).param).toBe("x");
    }
  });

  it("parses block body arrow with single return", () => {
    const fn = (u: { age: number }) => {
      return u.age > 18;
    };
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("binary");
    if (ir.kind === "binary") {
      expect(ir.op).toBe(">");
      expect(ir.left).toEqual({ kind: "member", param: "u", path: ["age"] });
      expect(ir.right).toEqual({ kind: "const", value: 18 });
    }
  });

  it("throws for unknown identifier", () => {
    const fn = (u: { age: number }) => u.age > unknownVar;
    expect(() => parseArrowToIr(fn)).toThrow();
  });

  it("parses literal number", () => {
    const fn = (u: { n: number }) => u.n === 42;
    const ir = parseArrowToIr(fn);
    expect(ir.kind).toBe("binary");
    if (ir.kind === "binary") {
      expect(ir.right).toEqual({ kind: "const", value: 42 });
    }
  });

  it("parses literal string", () => {
    const fn = (u: { s: string }) => u.s === "hello";
    const ir = parseArrowToIr(fn);
    if (ir.kind === "binary") {
      expect(ir.right).toEqual({ kind: "const", value: "hello" });
    }
  });

  it("throws for unsupported unary operator", () => {
    const fn = (u: { n: number }) => -u.n > 0;
    expect(() => parseArrowToIr(fn)).toThrow("Unsupported unary");
  });

  it("throws for unsupported method", () => {
    const fn = (u: { name: string }) => u.name.toUpperCase() === "X";
    expect(() => parseArrowToIr(fn)).toThrow("Unsupported method");
  });

  it("throws for unsupported binary operator", () => {
    const fn = (u: { a: number; b: number }) => u.a * u.b > 0;
    expect(() => parseArrowToIr(fn)).toThrow("Unsupported binary");
  });
});

describe("parser/parseArrowToIrSelect", () => {
  it("parses (u) => ({ id: u.id, name: u.name })", () => {
    const fn = (u: { id: number; name: string }) => ({ id: u.id, name: u.name });
    const ir = parseArrowToIrSelect(fn);
    expect(ir).toEqual({
      param: "u",
      paths: [["id"], ["name"]],
      aliases: ["id", "name"],
    });
  });

  it("parses (u) => ({ userId: u.id })", () => {
    const fn = (u: { id: number }) => ({ userId: u.id });
    const ir = parseArrowToIrSelect(fn);
    expect(ir).toEqual({
      param: "u",
      paths: [["id"]],
      aliases: ["userId"],
    });
  });

  it("returns null for non-object return", () => {
    const fn = (u: { id: number }) => u.id;
    expect(parseArrowToIrSelect(fn)).toBeNull();
  });

  it("returns null for computed keys", () => {
    const key = "id";
    const fn = (u: Record<string, number>) => ({ [key]: u.id });
    expect(parseArrowToIrSelect(fn)).toBeNull();
  });
});
