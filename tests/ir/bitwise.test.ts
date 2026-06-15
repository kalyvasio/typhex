import { describe, it, expect } from "vitest";
import { parseArrowToIr } from "../../src/parser/parse-arrow.js";
import type { IrNode } from "../../src/ir/types.js";
import {
  compileIrWhere,
  compileIrSelectList,
  postgresQueryCompiler,
} from "./compile-ir-helpers.js";

describe("runtime parser — bitwise operators", () => {
  for (const [op, jsOp] of [
    ["&", "&"],
    ["|", "|"],
    ["^", "^"],
    ["<<", "<<"],
    [">>", ">>"],
  ] as const) {
    it(`parses u.a ${jsOp} u.b > 0 into IrBinary with op "${op}"`, () => {
      const src = `(u) => (u.a ${jsOp} u.b) > 0`;
       
      const fn = new Function("return " + src)() as (u: { a: number; b: number }) => boolean;
      const ir = parseArrowToIr(fn) as { op: string; left: { op: string } };
      expect(ir.op).toBe(">");
      expect(ir.left.op).toBe(op);
    });
  }

  it("parses ~u.flags into IrUnary", () => {
    const fn = (u: { flags: number }) => ~u.flags > 0;
    const ir = parseArrowToIr(fn) as { left: { op: string; operand: { path: string[] } } };
    expect(ir.left.op).toBe("~");
    expect(ir.left.operand.path).toEqual(["flags"]);
  });

  it("throws for unsigned right shift >>>", () => {
    const fn = (u: { a: number; b: number }) => u.a >>> u.b > 0;
    expect(() => parseArrowToIr(fn)).toThrow("Unsupported binary");
  });
});

describe("SQL emission — bitwise", () => {
  const flagsMask: IrNode = {
    kind: "binary",
    op: "&",
    left: { kind: "member", param: "u", path: ["flags"] },
    right: { kind: "const", value: 4 },
  };

  it("emits & | << >> literally on SQLite and Postgres", () => {
    for (const op of ["&", "|", "<<", ">>"] as const) {
      const ir: IrNode = {
        kind: "binary",
        op,
        left: { kind: "member", param: "u", path: ["a"] },
        right: { kind: "member", param: "u", path: ["b"] },
      };
      const sqlite = compileIrWhere(ir);
      expect(sqlite.sql).toBe(`("t0"."a" ${op} "t0"."b")`);

      const pg = compileIrWhere(ir, postgresQueryCompiler);
      expect(pg.sql).toBe(`("t0"."a" ${op} "t0"."b")`);
    }
  });

  it("emits ~ as bitwise NOT", () => {
    const ir: IrNode = {
      kind: "unary",
      op: "~",
      operand: { kind: "member", param: "u", path: ["flags"] },
    };
    const sqlite = compileIrWhere(ir);
    expect(sqlite.sql).toBe(`(~"t0"."flags")`);
  });

  it("emits XOR with dialect-specific SQL", () => {
    const ir: IrNode = {
      kind: "binary",
      op: "^",
      left: { kind: "member", param: "u", path: ["a"] },
      right: { kind: "member", param: "u", path: ["b"] },
    };
    const sqlite = compileIrWhere(ir);
    expect(sqlite.sql).toBe(`(("t0"."a" & ~"t0"."b") | (~"t0"."a" & "t0"."b"))`);

    const pg = compileIrWhere(ir, postgresQueryCompiler);
    expect(pg.sql).toBe(`("t0"."a" # "t0"."b")`);
  });

  it("emits bitwise ops in SELECT expressions", () => {
    const select = {
      param: "u",
      paths: [],
      aliases: [],
      expressions: [{ alias: "masked", expr: flagsMask }],
    };
    const sql = compileIrSelectList(select, ["id"]);
    expect(sql).toContain(`"t0"."flags" & 4`);
  });
});
