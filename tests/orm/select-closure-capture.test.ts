import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import { Entity, createSqliteDriver } from "../../src/index.js";
import { sqliteDialect } from "../../src/dbs/index.js";
import { Db } from "../../src/orm/db.js";
import type { QueryExecutor } from "../../src/orm/db.js";
import type { IrSelect } from "../../src/ir/types.js";

const orderSchema = {
  id: "integer primary key autoincrement",
  category: "text not null",
  price: "integer not null",
  qty: "integer not null",
  active: "integer not null",
} as const;

class OrderRow extends Entity("orders", orderSchema) {}

function createMockQe(): QueryExecutor {
  return {
    dialect: sqliteDialect,
    query: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ lastID: 1, changes: 0 }),
  };
}

function newBuilder(qe: QueryExecutor): QueryBuilder<typeof OrderRow> {
  return new QueryBuilder<typeof OrderRow>({
    tableName: "orders",
    columnNames: ["id", "category", "price", "qty", "active"],
    qe,
    pkColumns: ["id"],
    whereIr: null,
    whereParams: {},
    subqueryParams: {},
    orderBy: [],
    limitNum: null,
    offsetNum: null,
    selectIr: null,
  });
}

describe(".select() closure-variable capture", () => {
  let qe: QueryExecutor;
  beforeEach(() => { qe = createMockQe(); });

  it("substitutes IrParam to IrConst from inlineParams before SQL emission", async () => {
    const selectIr: IrSelect = {
      param: "o",
      paths: [["category"]],
      aliases: ["category"],
      aggregates: [{
        kind: "aggregate",
        func: "SUM",
        arg: {
          kind: "case",
          branches: [{
            when: {
              kind: "binary", op: "<",
              left: { kind: "member", param: "o", path: ["qty"] },
              right: { kind: "param", key: "cutoff" },
            },
            then: { kind: "const", value: 1 },
          }],
          else: { kind: "const", value: 0 },
        },
        alias: "smalls",
      }],
    };
    await newBuilder(qe).select(selectIr, { cutoff: 5 }).toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain(`SUM((CASE WHEN ("t0"."qty" < 5) THEN 1 ELSE 0 END)) AS "smalls"`);
  });

  it("substitutes inside arithmetic expressions in SELECT", async () => {
    const factor = 100;
    await newBuilder(qe)
      .select((o: { price: number }) => ({ cents: o.price * factor }), { factor })
      .toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain(`("t0"."price" * 100) AS "cents"`);
  });

  it("substitutes inside ORDER BY expression via inlineParams", async () => {
    const threshold = 10;
    await newBuilder(qe)
      .select((o: { qty: number }) => ({ qty: o.qty }), { threshold })
      .orderBy((o: { qty: number }) => (o.qty < threshold ? 0 : 1))
      .toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain(`ORDER BY (CASE WHEN ("t0"."qty" < 10) THEN 0 ELSE 1 END) ASC`);
  });

  it("substitutes inside arithmetic ORDER BY expression via inlineParams", async () => {
    const factor = 100;
    await newBuilder(qe)
      .select((o: { price: number }) => ({ price: o.price }), { factor })
      .orderBy((o: { price: number }) => o.price * factor)
      .toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain(`ORDER BY ("t0"."price" * 100) ASC`);
  });

  it("accepts unary computed ORDER BY at runtime", async () => {
    await newBuilder(qe)
      .select((o: { active: number; flags: number }) => ({ active: o.active, flags: o.flags }))
      .orderBy((o: { flags: number }) => ~o.flags)
      .toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain(`ORDER BY (~"t0"."flags") ASC`);
  });

  it("throws a clear error when a referenced param is missing", async () => {
    const qb = newBuilder(qe);
    qb.select(
      {
        param: "o",
        paths: [],
        aggregates: [{
          kind: "aggregate", func: "SUM",
          arg: {
            kind: "case",
            branches: [{
              when: {
                kind: "binary", op: "<",
                left: { kind: "member", param: "o", path: ["qty"] },
                right: { kind: "param", key: "missing" },
              },
              then: { kind: "const", value: 1 },
            }],
            else: { kind: "const", value: 0 },
          },
          alias: "flag",
        }],
      },
      {},
    );
    await expect(qb.toArray()).rejects.toThrow(/inline param "missing" not provided/);
  });

  it("throws a clear error when a captured value is non-primitive", async () => {
    const date = new Date();
    const qb = newBuilder(qe);
    qb.select(
      {
        param: "o",
        paths: [],
        expressions: [{
          expr: { kind: "param", key: "date" },
          alias: "snap",
        }],
      },
      { date },
    );
    await expect(qb.toArray()).rejects.toThrow(/Cannot inline SQL literal of type/);
  });
});

describe("end-to-end SQLite — closure capture in select() + sum(CASE ...)", () => {
  it("counts rows below a runtime threshold per category", async () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    const db = new Db(driver);
    try {
      await driver.execute(
        'CREATE TABLE "orders" ("id" integer primary key autoincrement, "category" text not null, "price" integer not null, "qty" integer not null, "active" integer not null)'
      );
      await driver.execute(`INSERT INTO "orders" ("category","price","qty","active") VALUES
        ('a', 10, 2, 1),
        ('a', 20, 6, 1),
        ('a', 15, 4, 1),
        ('b',  5, 1, 1),
        ('b', 15, 9, 1)`);

      const qe: QueryExecutor = {
        dialect: sqliteDialect,
        query: (sql, params) => driver.execute(sql, params).then(r => r.rows as Record<string, unknown>[]),
        run: (sql, params) => driver.execute(sql, params).then(r => ({ lastID: r.lastID, changes: r.changes })),
      };

      const cutoff = 5;
      const qb = new QueryBuilder<typeof OrderRow>({
        tableName: "orders",
        columnNames: ["id", "category", "price", "qty", "active"],
        qe,
        pkColumns: ["id"],
        whereIr: null,
        whereParams: {},
        subqueryParams: {},
        orderBy: [],
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      });

      const rows = await qb
        .select({
          param: "o",
          paths: [["category"]],
          aliases: ["category"],
          aggregates: [{
            kind: "aggregate",
            func: "SUM",
            arg: {
              kind: "case",
              branches: [{
                when: {
                  kind: "binary", op: "<",
                  left: { kind: "member", param: "o", path: ["qty"] },
                  right: { kind: "param", key: "cutoff" },
                },
                then: { kind: "const", value: 1 },
              }],
              else: { kind: "const", value: 0 },
            },
            alias: "smalls",
          }],
        }, { cutoff })
        .groupBy("category")
        .orderBy("category")
        .toArray() as unknown as Array<{ category: string; smalls: number }>;
      expect(rows).toEqual([
        { category: "a", smalls: 2 },
        { category: "b", smalls: 1 },
      ]);
    } finally {
      await db.close();
    }
  });
});
