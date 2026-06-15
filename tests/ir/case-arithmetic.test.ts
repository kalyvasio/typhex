import { describe, it, expect } from "vitest";
import { parseArrowToIr } from "../../src/parser/parse-arrow.js";
import { createSqliteDriver } from "../../src/dbs/index.js";
import { Db } from "../../src/orm/db.js";
import type { IrCase, IrNode } from "../../src/ir/types.js";
import {
  compileIrWhere,
  compileIrSelectList,
  sqliteQueryCompiler,
  postgresQueryCompiler,
} from "./compile-ir-helpers.js";

describe("runtime parser — ternary (ConditionalExpression)", () => {
  it("parses u.active ? 1 : 2 into IrCase", () => {
    const fn = (u: { active: boolean }) => (u.active ? 1 : 2);
    const ir = parseArrowToIr(fn) as IrCase;
    expect(ir.kind).toBe("case");
    expect(ir.branches).toHaveLength(1);
    expect(ir.branches[0].when).toEqual({ kind: "member", param: "u", path: ["active"] });
    expect(ir.branches[0].then).toEqual({ kind: "const", value: 1 });
    expect(ir.else).toEqual({ kind: "const", value: 2 });
  });

  it("flattens chained ternaries into a single IrCase", () => {
    const fn = (u: { age: number }) => (u.age < 18 ? "minor" : u.age < 65 ? "adult" : "senior");
    const ir = parseArrowToIr(fn) as IrCase;
    expect(ir.kind).toBe("case");
    expect(ir.branches).toHaveLength(2);
    expect(ir.else).toEqual({ kind: "const", value: "senior" });
  });

  it("accepts complex boolean tests (&& / ||) in the ternary condition", () => {
    const fn = (u: { age: number; active: boolean }) => (u.age < 18 && u.active ? 1 : 0);
    const ir = parseArrowToIr(fn) as IrCase;
    expect(ir.kind).toBe("case");
    expect(ir.branches[0].when.kind).toBe("binary");
    expect((ir.branches[0].when as { op: string }).op).toBe("&&");
  });

  it("accepts nested member paths in the ternary condition", () => {
    const fn = (u: { active: boolean; manager: { pay: number } }) =>
      u.active && u.manager.pay > 1999 ? 1 : 0;
    const ir = parseArrowToIr(fn) as IrCase;
    expect(ir.kind).toBe("case");
  });
});

describe("runtime parser — arithmetic operators", () => {
  for (const [op, jsOp] of [
    ["+", "+"],
    ["-", "-"],
    ["*", "*"],
    ["/", "/"],
    ["%", "%"],
  ] as const) {
    it(`parses u.a ${jsOp} u.b > 0 into IrBinary with op "${op}"`, () => {
      const src = `(u) => (u.a ${jsOp} u.b) > 0`;

      const fn = new Function("return " + src)() as (u: { a: number; b: number }) => boolean;
      const ir = parseArrowToIr(fn) as { op: string; left: { op: string } };
      expect(ir.op).toBe(">");
      expect(ir.left.op).toBe(op);
    });
  }
});

describe("SQL emission — IrCase", () => {
  it("emits CASE WHEN ... THEN ... ELSE ... END", () => {
    const ir: IrNode = {
      kind: "case",
      branches: [
        {
          when: { kind: "member", param: "u", path: ["active"] },
          then: { kind: "const", value: 1 },
        },
      ],
      else: { kind: "const", value: 2 },
    };
    const sqlite = compileIrWhere(ir);
    expect(sqlite.sql).toBe(`(CASE WHEN "t0"."active" THEN 1 ELSE 2 END)`);
    expect(sqlite.params).toEqual([]);

    const pg = compileIrWhere(ir, postgresQueryCompiler);
    expect(pg.sql).toBe(`(CASE WHEN "t0"."active" THEN 1 ELSE 2 END)`);
    expect(pg.params).toEqual([]);
  });

  it("emits multiple WHEN branches for chained ternaries", () => {
    const ir: IrNode = {
      kind: "case",
      branches: [
        {
          when: {
            kind: "binary",
            op: "<",
            left: { kind: "member", param: "u", path: ["age"] },
            right: { kind: "const", value: 18 },
          },
          then: { kind: "const", value: "minor" },
        },
        {
          when: {
            kind: "binary",
            op: "<",
            left: { kind: "member", param: "u", path: ["age"] },
            right: { kind: "const", value: 65 },
          },
          then: { kind: "const", value: "adult" },
        },
      ],
      else: { kind: "const", value: "senior" },
    };
    const { sql } = compileIrWhere(ir);
    expect(sql).toBe(
      `(CASE WHEN ("t0"."age" < 18) THEN 'minor' WHEN ("t0"."age" < 65) THEN 'adult' ELSE 'senior' END)`,
    );
  });

  it("emits CASE without ELSE when else is absent", () => {
    const ir: IrNode = {
      kind: "case",
      branches: [
        {
          when: { kind: "member", param: "u", path: ["active"] },
          then: { kind: "const", value: 1 },
        },
      ],
    };
    const { sql } = compileIrWhere(ir);
    expect(sql).toBe(`(CASE WHEN "t0"."active" THEN 1 END)`);
  });
});

describe("SQL emission — arithmetic", () => {
  for (const op of ["+", "-", "*", "/", "%"] as const) {
    it(`emits ${op} for IrBinary op "${op}"`, () => {
      const ir: IrNode = {
        kind: "binary",
        op,
        left: { kind: "member", param: "u", path: ["price"] },
        right: { kind: "member", param: "u", path: ["qty"] },
      };
      const { sql } = compileIrWhere(ir);
      expect(sql).toBe(`("t0"."price" ${op} "t0"."qty")`);
    });
  }

  it("compiles SUM((price * qty)) correctly", () => {
    const irSelect = {
      param: "o",
      paths: [],
      aggregates: [
        {
          kind: "aggregate" as const,
          func: "SUM" as const,
          arg: {
            kind: "binary" as const,
            op: "*" as const,
            left: { kind: "member" as const, param: "o", path: ["price"] },
            right: { kind: "member" as const, param: "o", path: ["qty"] },
          },
          alias: "revenue",
        },
      ],
    };
    const sql = compileIrSelectList(irSelect, ["id", "price", "qty"]);
    expect(sql).toContain("SUM(");
    expect(sql).toContain(`("t0"."price" * "t0"."qty")`);
    expect(sql).toContain(`AS "revenue"`);
  });

  it("compiles SUM(CASE WHEN active THEN 1 ELSE 2 END) with inlined literals", () => {
    const irSelect = {
      param: "o",
      paths: [],
      aggregates: [
        {
          kind: "aggregate" as const,
          func: "SUM" as const,
          arg: {
            kind: "case" as const,
            branches: [
              {
                when: { kind: "member" as const, param: "o", path: ["active"] },
                then: { kind: "const" as const, value: 1 },
              },
            ],
            else: { kind: "const" as const, value: 2 },
          },
          alias: "flagged",
        },
      ],
    };
    const sql = compileIrSelectList(irSelect, ["id", "active"], sqliteQueryCompiler);
    expect(sql).toBe(`SUM((CASE WHEN "t0"."active" THEN 1 ELSE 2 END)) AS "flagged"`);
  });

  it("escapes string literals inside SUM(CASE ... THEN 'str' ...)", () => {
    const irSelect = {
      param: "o",
      paths: [],
      aggregates: [
        {
          kind: "aggregate" as const,
          func: "COUNT" as const,
          arg: {
            kind: "case" as const,
            branches: [
              {
                when: {
                  kind: "binary" as const,
                  op: "===" as const,
                  left: { kind: "member" as const, param: "o", path: ["status"] },
                  right: { kind: "const" as const, value: "it's ok" },
                },
                then: { kind: "const" as const, value: 1 },
              },
            ],
            else: { kind: "const" as const, value: null },
          },
          alias: "hits",
        },
      ],
    };
    const sql = compileIrSelectList(irSelect, ["id", "status"], sqliteQueryCompiler);
    expect(sql).toBe(
      `COUNT((CASE WHEN ("t0"."status" = 'it''s ok') THEN 1 ELSE NULL END)) AS "hits"`,
    );
  });
});

describe("end-to-end sqlite — CASE + arithmetic", () => {
  it("computes SUM(price * qty) and SUM(CASE WHEN active THEN 1 ELSE 2 END)", async () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    const db = new Db(driver);
    try {
      await driver.execute(
        'CREATE TABLE "orders" ("id" integer primary key autoincrement, "price" integer, "qty" integer, "active" integer)',
      );
      await driver.execute('INSERT INTO "orders" ("price", "qty", "active") VALUES (10, 2, 1)');
      await driver.execute('INSERT INTO "orders" ("price", "qty", "active") VALUES (20, 3, 0)');
      await driver.execute('INSERT INTO "orders" ("price", "qty", "active") VALUES (5, 4, 1)');

      const revenue = await driver.execute(
        'SELECT SUM(("t0"."price" * "t0"."qty")) AS "revenue" FROM "orders" "t0"',
      );
      expect(revenue.rows[0]).toEqual({ revenue: 10 * 2 + 20 * 3 + 5 * 4 });

      const flagged = await driver.execute(
        'SELECT SUM((CASE WHEN "t0"."active" THEN 1 ELSE 2 END)) AS "flagged" FROM "orders" "t0"',
      );
      expect(flagged.rows[0]).toEqual({ flagged: 1 + 2 + 1 });
    } finally {
      await db.close();
    }
  });
});
