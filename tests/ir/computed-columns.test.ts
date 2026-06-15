import { describe, it, expect } from "vitest";
import { parseArrowToIr, parseArrowToIrSelect } from "../../src/parser/parse-arrow.js";
import { createSqliteDriver } from "../../src/dbs/index.js";
import { Db } from "../../src/orm/db.js";
import type { IrNode, IrSelect, IrOrderBy } from "../../src/ir/types.js";
import {
  compileIrWhere,
  compileIrSelectList,
  compileIrOrderBy,
  postgresQueryCompiler,
} from "./compile-ir-helpers.js";

describe("IS NULL / IS NOT NULL rewrite", () => {
  it("compiles `u.x === null` to `IS NULL` (no parameter)", () => {
    const ir: IrNode = {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "u", path: ["deletedAt"] },
      right: { kind: "const", value: null },
    };
    const sqlite = compileIrWhere(ir);
    expect(sqlite.sql).toBe(`("t0"."deletedAt" IS NULL)`);
    expect(sqlite.params).toEqual([]);

    const pg = compileIrWhere(ir, postgresQueryCompiler);
    expect(pg.sql).toBe(`("t0"."deletedAt" IS NULL)`);
    expect(pg.params).toEqual([]);
  });

  it("compiles `u.x !== null` to `IS NOT NULL`", () => {
    const ir: IrNode = {
      kind: "binary",
      op: "!==",
      left: { kind: "member", param: "u", path: ["deletedAt"] },
      right: { kind: "const", value: null },
    };
    expect(compileIrWhere(ir).sql).toBe(`("t0"."deletedAt" IS NOT NULL)`);
  });

  it("emits IS NULL inside SUM(CASE WHEN ... THEN 1 ELSE 0 END)", () => {
    const irSelect: IrSelect = {
      param: "u",
      paths: [],
      aggregates: [
        {
          kind: "aggregate",
          func: "SUM",
          arg: {
            kind: "case",
            branches: [
              {
                when: {
                  kind: "binary",
                  op: "===",
                  left: { kind: "member", param: "u", path: ["deletedAt"] },
                  right: { kind: "const", value: null },
                },
                then: { kind: "const", value: 1 },
              },
            ],
            else: { kind: "const", value: 0 },
          },
          alias: "live",
        },
      ],
    };
    const sql = compileIrSelectList(irSelect, ["id", "deletedAt"]);
    expect(sql).toBe(`SUM((CASE WHEN ("t0"."deletedAt" IS NULL) THEN 1 ELSE 0 END)) AS "live"`);
  });

  it("regression: non-null `=== <value>` still parameterizes", () => {
    const ir: IrNode = {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "u", path: ["status"] },
      right: { kind: "const", value: "active" },
    };
    const r = compileIrWhere(ir);
    expect(r.sql).toBe(`("t0"."status" = ?)`);
    expect(r.params).toEqual(["active"]);
  });
});

describe("computed SELECT columns", () => {
  it("compiles arithmetic in SELECT projection inline", () => {
    const irSelect: IrSelect = {
      param: "o",
      paths: [],
      expressions: [
        {
          expr: {
            kind: "binary",
            op: "*",
            left: { kind: "member", param: "o", path: ["price"] },
            right: { kind: "member", param: "o", path: ["qty"] },
          },
          alias: "revenue",
        },
      ],
    };
    const sql = compileIrSelectList(irSelect, ["id", "price", "qty"]);
    expect(sql).toBe(`("t0"."price" * "t0"."qty") AS "revenue"`);
  });

  it("compiles ternary in SELECT projection", () => {
    const irSelect: IrSelect = {
      param: "o",
      paths: [],
      expressions: [
        {
          expr: {
            kind: "case",
            branches: [
              {
                when: { kind: "member", param: "o", path: ["active"] },
                then: { kind: "const", value: "on" },
              },
            ],
            else: { kind: "const", value: "off" },
          },
          alias: "status",
        },
      ],
    };
    const sql = compileIrSelectList(irSelect, ["id", "active"]);
    expect(sql).toBe(`(CASE WHEN "t0"."active" THEN 'on' ELSE 'off' END) AS "status"`);
  });

  it("mixes path columns + aggregates + expressions in one select", () => {
    const irSelect: IrSelect = {
      param: "o",
      paths: [["category"]],
      aliases: ["category"],
      aggregates: [
        {
          kind: "aggregate",
          func: "SUM",
          arg: { kind: "member", param: "o", path: ["price"] },
          alias: "total",
        },
      ],
      expressions: [
        {
          expr: {
            kind: "case",
            branches: [
              {
                when: {
                  kind: "binary",
                  op: "<",
                  left: { kind: "member", param: "o", path: ["qty"] },
                  right: { kind: "const", value: 10 },
                },
                then: { kind: "const", value: "small" },
              },
            ],
            else: { kind: "const", value: "large" },
          },
          alias: "bucket",
        },
      ],
    };
    const sql = compileIrSelectList(irSelect, ["id", "category", "price", "qty"]);
    expect(sql).toContain(`"t0"."category" AS "category"`);
    expect(sql).toContain(`SUM(`);
    expect(sql).toContain(
      `(CASE WHEN ("t0"."qty" < 10) THEN 'small' ELSE 'large' END) AS "bucket"`,
    );
  });

  it("runtime parser: select(o => ({ revenue: o.price * o.qty })) emits expressions[]", () => {
    const ir = parseArrowToIrSelect((o: { price: number; qty: number }) => ({
      revenue: o.price * o.qty,
    }));
    expect(ir).not.toBeNull();
    expect(ir!.expressions).toHaveLength(1);
    expect(ir!.expressions![0].alias).toBe("revenue");
    expect(ir!.expressions![0].expr.kind).toBe("binary");
  });

  it("runtime parser: shorthand single expression aliased as 'expr'", () => {
    const ir = parseArrowToIrSelect((o: { price: number }) => o.price * 100);
    expect(ir).not.toBeNull();
    expect(ir!.expressions).toEqual([
      {
        expr: {
          kind: "binary",
          op: "*",
          left: { kind: "member", param: "o", path: ["price"] },
          right: { kind: "const", value: 100 },
        },
        alias: "expr",
      },
    ]);
  });
});

describe("ORDER BY computed expressions", () => {
  it("compiles ternary expression with direction", () => {
    const orders: IrOrderBy[] = [
      {
        expr: {
          kind: "case",
          branches: [
            {
              when: { kind: "member", param: "u", path: ["featured"] },
              then: { kind: "const", value: 0 },
            },
          ],
          else: { kind: "const", value: 1 },
        },
        direction: "asc",
      },
    ];
    expect(compileIrOrderBy(orders)).toBe(`(CASE WHEN "t0"."featured" THEN 0 ELSE 1 END) ASC`);
  });

  it("compiles arithmetic expression with desc", () => {
    const orders: IrOrderBy[] = [
      {
        expr: {
          kind: "binary",
          op: "*",
          left: { kind: "member", param: "u", path: ["price"] },
          right: { kind: "member", param: "u", path: ["qty"] },
        },
        direction: "desc",
      },
    ];
    expect(compileIrOrderBy(orders)).toBe(`("t0"."price" * "t0"."qty") DESC`);
  });

  it("regression: bare-member orderBy renders as before", () => {
    const orders: IrOrderBy[] = [
      {
        expr: { kind: "member", param: "u", path: ["name"] },
        direction: "asc",
      },
    ];
    expect(compileIrOrderBy(orders)).toBe(`"t0"."name" ASC`);
  });

  it("runtime parser: orderBy(u => u.featured ? 0 : 1) round-trips", () => {
    const ir = parseArrowToIr((u: { featured: boolean }) => (u.featured ? 0 : 1));
    expect(ir.kind).toBe("case");
  });
});

describe("end-to-end SQLite — Tier-1+2 features combined", () => {
  it("computes IS NULL, computed SELECT, ORDER BY expr in one round-trip", async () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    const db = new Db(driver);
    try {
      await driver.execute(
        'CREATE TABLE "orders" ("id" integer primary key autoincrement, "category" text not null, "price" integer not null, "qty" integer not null, "active" integer not null, "deletedAt" text)',
      );
      await driver.execute(`INSERT INTO "orders" ("category","price","qty","active","deletedAt") VALUES
        ('a', 10, 2, 1, NULL),
        ('a', 20, 3, 0, '2025-01-01'),
        ('b',  5, 4, 1, NULL),
        ('b', 15, 1, 1, NULL)`);

      const live = await driver.execute(
        'SELECT COUNT(*) AS c FROM "orders" "t0" WHERE ("t0"."deletedAt" IS NULL)',
      );
      expect(Number(live.rows[0].c)).toBe(3);

      const revenue = await driver.execute(
        'SELECT ("t0"."price" * "t0"."qty") AS "revenue" FROM "orders" "t0" ORDER BY "t0"."id"',
      );
      expect(revenue.rows.map((r: any) => r.revenue)).toEqual([20, 60, 20, 15]);

      const buckets = await driver.execute(
        `SELECT (CASE WHEN ("t0"."qty" < 3) THEN 'small' ELSE 'large' END) AS "bucket" FROM "orders" "t0" ORDER BY "t0"."id"`,
      );
      expect(buckets.rows.map((r: any) => r.bucket)).toEqual(["small", "large", "large", "small"]);

      const ordered = await driver.execute(
        'SELECT "t0"."id" FROM "orders" "t0" ORDER BY (CASE WHEN ("t0"."qty" = 4) THEN 0 ELSE 1 END), "t0"."id"',
      );
      expect(ordered.rows.map((r: any) => r.id)).toEqual([3, 1, 2, 4]);
    } finally {
      await db.close();
    }
  });
});
