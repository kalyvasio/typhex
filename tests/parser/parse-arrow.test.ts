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

  it("parses relation.some() for one-to-many EXISTS", () => {
    const fn = (d: { employees: { name: string }[] }) => d.employees.some((e) => e.name === "Alice");
    const ir = parseArrowToIr(fn, { paramNames: ["d"] });
    expect(ir.kind).toBe("exists");
    if (ir.kind === "exists") {
      expect(ir.rootParam).toBe("d");
      expect(ir.relationKey).toBe("employees");
      expect(ir.innerParam).toBe("e");
      expect(ir.innerWhere.kind).toBe("binary");
      if (ir.innerWhere.kind === "binary") {
        expect(ir.innerWhere.op).toBe("===");
        expect((ir.innerWhere.left as { path: string[] }).path).toEqual(["name"]);
        expect((ir.innerWhere.right as { value: unknown }).value).toBe("Alice");
      }
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
    expect(ir?.param).toBe("u");
    expect(ir?.paths).toEqual([["id"], ["name"]]);
    expect(ir?.aliases).toEqual(["id", "name"]);
  });

  it("parses (u) => ({ userId: u.id })", () => {
    const fn = (u: { id: number }) => ({ userId: u.id });
    const ir = parseArrowToIrSelect(fn);
    expect(ir?.param).toBe("u");
    expect(ir?.paths).toEqual([["id"]]);
    expect(ir?.aliases).toEqual(["userId"]);
  });

  it("parses (c) => ({ ...c, company: c.company }) with spread of param", () => {
    const fn = (c: { id: number; name: string; company: unknown }) => ({ ...c, company: c.company });
    const ir = parseArrowToIrSelect(fn);
    expect(ir?.param).toBe("c");
    expect(ir?.paths).toEqual([["company"]]);
    expect(ir?.aliases).toEqual(["company"]);
    expect(ir?.rest).toBe(true);
  });

  it("parses nested relation select (p) => ({ id: p.id, author: { id: p.author.id, name: p.author.name } })", () => {
    const fn = (p: { id: number; author: { id: number; name: string } }) => ({
      id: p.id,
      author: { id: p.author.id, name: p.author.name },
    });
    const ir = parseArrowToIrSelect(fn);
    expect(ir?.param).toBe("p");
    expect(ir?.paths).toEqual([["id"]]);
    expect(ir?.aliases).toEqual(["id"]);
    expect(ir?.relations).toEqual([
      { name: "author", outputKey: "author", subPaths: [["id"], ["name"]] },
    ]);
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

  it("parses relation query chain u.posts.query().select((p) => ({ id: p.id, title: p.title }))", () => {
    const fn = (u: any) => ({
      id: u.id,
      posts: u.posts.query().select((p: any) => ({ id: p.id, title: p.title })),
    });
    const ir = parseArrowToIrSelect(fn);
    expect(ir?.param).toBe("u");
    expect(ir?.paths).toEqual([["id"]]);
    expect(ir?.relations).toHaveLength(1);
    expect(ir?.relations?.[0]).toMatchObject({
      name: "posts",
      outputKey: "posts",
      subPaths: [["id"], ["title"]],
    });
  });

  it("parses relation query chain with where and orderBy", () => {
    const fn = (u: any) => ({
      id: u.id,
      posts: u.posts
        .query()
        .where((p: any) => p.published === true)
        .orderBy("title", "asc")
        .limit(5)
        .select((p: any) => ({ id: p.id })),
    });
    const ir = parseArrowToIrSelect(fn);
    expect(ir?.relations?.[0]).toMatchObject({
      name: "posts",
      outputKey: "posts",
      subPaths: [["id"]],
      limitNum: 5,
    });
    expect(ir?.relations?.[0].whereIr).toBeDefined();
    expect(ir?.relations?.[0].orderBy).toEqual([{ param: "u", path: ["title"], direction: "asc" }]);
  });
});
