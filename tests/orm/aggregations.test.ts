import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import { Entity } from "../../src/index.js";
import type { QueryExecutor } from "../../src/orm/db.js";
import type { IrAggregate, IrHaving, IrNode, IrSelect } from "../../src/ir/types.js";
import { isIrNode } from "../../src/ir/types.js";
import { sqliteDialect, postgresDialect } from "../../src/dbs/index.js";
import {
  compileAggregate,
  compileSelectListExpr,
  compileWhereExpr,
  compileGroupBy,
} from "../../src/dbs/shared-dialect.js";
import type { DialectImpl } from "../../src/dbs/types.js";
import type {
  Expr,
  ExprAggregate,
  ExprColumn,
  GroupByItem,
  SelectItem,
} from "../../src/orm/expr.js";

function aggCompiler(dialect: DialectImpl) {
  return dialect.compileAggregate
    ? (agg: ExprAggregate, fn: (n: Expr, p: unknown[]) => string, p: unknown[]) =>
        dialect.compileAggregate!(agg, fn, p)
    : undefined;
}

function compileItems(
  items: SelectItem[],
  columnNames: string[],
  dialect: DialectImpl,
  tableAlias = "t0",
): { sql: string; params: unknown[] } {
  return compileSelectListExpr(
    items,
    false,
    tableAlias,
    columnNames,
    dialect,
    aggCompiler(dialect),
  );
}

const orderSchema = {
  id: "integer primary key autoincrement",
  category: "text",
  price: "integer",
  status: "text",
} as const;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
class OrderEntity extends Entity("orders", orderSchema) {}

function createMockQe(dialect: "sqlite" | "postgres" = "sqlite"): QueryExecutor {
  return {
    dialect,
    query: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ lastID: 1, changes: 0 }),
  };
}

function newBuilder(
  qe: QueryExecutor,
  columnNames = ["id", "category", "price", "status"],
): QueryBuilder<typeof OrderEntity> {
  return new QueryBuilder<typeof OrderEntity, InstanceType<typeof OrderEntity>>({
    tableName: "orders",
    columnNames,
    qe,
    pkColumns: ["id"],
    whereIr: null,
    whereParams: {},
    subqueryParams: {},
    orderBy: [],
    havingIr: null,
    havingParams: {},
    limitNum: null,
    offsetNum: null,
    selectIr: null,
  });
}

function having(node: IrNode, rootParam = "u"): IrHaving {
  return { node, rootParam, localParamNames: [rootParam] };
}

describe("Aggregations", () => {
  let qe: QueryExecutor;

  beforeEach(() => {
    qe = createMockQe();
  });

  describe("compileSelectListExpr with aggregates", () => {
    it("COUNT(*) in select compiles correctly", () => {
      const items: SelectItem[] = [
        {
          expr: { kind: "aggregate", func: "COUNT", arg: null, alias: "total" } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "category", "price"], sqliteDialect);
      expect(sql).toContain("COUNT(*)");
      expect(sql).toContain('AS "total"');
    });

    it("SUM(price) in select compiles correctly", () => {
      const items: SelectItem[] = [
        { expr: { kind: "column", alias: "t0", column: ["category"] }, alias: "category" },
        {
          expr: {
            kind: "aggregate",
            func: "SUM",
            arg: { kind: "column", alias: "t0", column: ["price"] },
            alias: "totalPrice",
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "category", "price"], sqliteDialect);
      expect(sql).toContain("SUM(");
      expect(sql).toContain('"price"');
      expect(sql).toContain('AS "totalPrice"');
      expect(sql).toContain('"category"');
    });

    it("AVG, MIN, MAX aggregate functions compile correctly", () => {
      const funcs: Array<"AVG" | "MIN" | "MAX"> = ["AVG", "MIN", "MAX"];
      for (const func of funcs) {
        const items: SelectItem[] = [
          {
            expr: {
              kind: "aggregate",
              func,
              arg: { kind: "column", alias: "t0", column: ["price"] },
              alias: "result",
            } as ExprAggregate,
          },
        ];
        const { sql } = compileItems(items, ["id", "price"], sqliteDialect);
        expect(sql).toContain(`${func}(`);
        expect(sql).toContain('AS "result"');
      }
    });

    it("DISTINCT modifier is included in aggregate SQL", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "COUNT",
            arg: { kind: "column", alias: "t0", column: ["category"] },
            alias: "uniqueCategories",
            distinct: true,
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "category"], sqliteDialect);
      expect(sql).toContain("COUNT(DISTINCT ");
      expect(sql).toContain('AS "uniqueCategories"');
    });
  });

  describe("groupBy method", () => {
    it("groupBy(string) stores groupBy in selectIr and produces GROUP BY SQL", async () => {
      await newBuilder(qe).groupBy("category").toArray();
      expect(qe.query).toHaveBeenCalled();
      const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain('"category"');
    });

    it("groupBy(string[]) handles multiple columns", async () => {
      await newBuilder(qe).groupBy(["category", "status"]).toArray();
      const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain('"category"');
      expect(sql).toContain('"status"');
    });

    it("groupBy(string, ...rest) handles variadic string args", async () => {
      await newBuilder(qe).groupBy("category", "status").toArray();
      const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain('"category"');
      expect(sql).toContain('"status"');
    });

    it("groupBy(lambda) single member extracts path", async () => {
      await newBuilder(qe)
        .groupBy((o: InstanceType<typeof OrderEntity>) => o.category)
        .toArray();
      const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain('"category"');
    });

    it("groupBy returns the same QueryBuilder (mutates in place)", () => {
      const base = newBuilder(qe);
      const q = base.groupBy("category");
      expect(q).toBeInstanceOf(QueryBuilder);
      expect(q).toBe(base);
    });
  });

  describe("having method", () => {
    it("having(IrNode) produces HAVING clause in SQL", async () => {
      const havingIr = having({
        kind: "binary" as const,
        op: ">" as const,
        left: { kind: "aggregate" as const, func: "COUNT" as const, arg: null },
        right: { kind: "const" as const, value: 5 },
      });
      await newBuilder(qe).groupBy("category").having(havingIr).toArray();
      const [sql, params] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("HAVING");
      expect(params).toContain(5);
    });

    it("having(arrow) parses and produces HAVING clause", async () => {
      const countAgg: IrAggregate = { kind: "aggregate", func: "COUNT", arg: null };
      const havingIr = having({
        kind: "binary" as const,
        op: ">" as const,
        left: countAgg,
        right: { kind: "const" as const, value: 10 },
      });
      await newBuilder(qe).groupBy("category").having(havingIr).toArray();
      const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("HAVING");
      expect(sql).toContain("GROUP BY");
    });

    it("having returns the same QueryBuilder (mutates in place)", () => {
      const havingIr = having({
        kind: "binary" as const,
        op: ">" as const,
        left: { kind: "aggregate" as const, func: "COUNT" as const, arg: null },
        right: { kind: "const" as const, value: 1 },
      });
      const base = newBuilder(qe);
      const q = base.having(havingIr);
      expect(q).toBeInstanceOf(QueryBuilder);
      expect(q).toBe(base);
    });
  });

  describe("combined GROUP BY + HAVING + aggregates via QueryBuilder", () => {
    it("builds correct SQL for SELECT category, SUM(price) ... GROUP BY category HAVING COUNT(*) > 5 ORDER BY category", async () => {
      const selectIr: IrSelect = {
        param: "u",
        paths: [["category"]],
        aliases: ["category"],
        aggregates: [
          {
            kind: "aggregate",
            func: "SUM",
            arg: { kind: "member", param: "u", path: ["price"] },
            alias: "totalPrice",
          },
        ],
        groupBy: [["category"]],
      };

      const havingIr = having({
        kind: "binary" as const,
        op: ">" as const,
        left: { kind: "aggregate" as const, func: "COUNT" as const, arg: null },
        right: { kind: "const" as const, value: 5 },
      });

      await newBuilder(qe).select(selectIr).having(havingIr).orderBy("category").toArray();

      const [sql, params] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("SELECT");
      expect(sql).toContain("SUM(");
      expect(sql).toContain('"totalPrice"');
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("HAVING");
      expect(sql).toContain("ORDER BY");
      expect(params).toContain(5);
    });

    it("COUNT(*) only select produces valid aggregate-only SQL", async () => {
      const selectIr: IrSelect = {
        param: "u",
        paths: [],
        aggregates: [{ kind: "aggregate", func: "COUNT", arg: null, alias: "total" }],
      };
      await newBuilder(qe).select(selectIr).toArray();
      const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('COUNT(*) AS "total"');
      expect(sql).toContain("FROM");
    });
  });

  describe("IrAggregate in IrNode union (isIrNode check)", () => {
    it("isIrNode returns true for aggregate kind", () => {
      const agg: IrAggregate = { kind: "aggregate", func: "COUNT", arg: null };
      expect(isIrNode(agg)).toBe(true);
    });

    it("isIrNode returns true for aggregate with arg", () => {
      const agg: IrAggregate = {
        kind: "aggregate",
        func: "SUM",
        arg: { kind: "member", param: "u", path: ["price"] },
        alias: "total",
      };
      expect(isIrNode(agg)).toBe(true);
    });
  });

  describe("compileSelect GROUP BY and HAVING integration", () => {
    it("SQLite: GROUP BY and HAVING appear in correct order in SQL", () => {
      const groupBy: GroupByItem[] = [{ kind: "column", alias: "t0", column: ["category"] }];
      const result = sqliteDialect.compileSelect({
        table: "orders",
        tableAlias: "t0",
        selectList: '"t0"."category", COUNT(*) AS "total"',
        whereSql: "1=1",
        whereParams: [],
        orderBySql: '"t0"."category" ASC',
        limitNum: null,
        offsetNum: null,
        groupBy,
        havingSql: "(COUNT(*) > ?)",
        havingParams: [5],
      });
      expect(result.sql).toContain("GROUP BY");
      expect(result.sql).toContain("HAVING");
      expect(result.sql).toContain("ORDER BY");
      const groupByIdx = result.sql.indexOf("GROUP BY");
      const havingIdx = result.sql.indexOf("HAVING");
      const orderByIdx = result.sql.indexOf("ORDER BY");
      expect(groupByIdx).toBeLessThan(havingIdx);
      expect(havingIdx).toBeLessThan(orderByIdx);
      expect(result.params).toContain(5);
    });

    it("SQLite: LIMIT and OFFSET appear after HAVING", () => {
      const groupBy: GroupByItem[] = [{ kind: "column", alias: "t0", column: ["category"] }];
      const result = sqliteDialect.compileSelect({
        table: "orders",
        tableAlias: "t0",
        selectList: "COUNT(*) AS total",
        whereSql: "1=1",
        whereParams: [],
        orderBySql: "",
        limitNum: 10,
        offsetNum: 5,
        groupBy,
        havingSql: "(COUNT(*) > ?)",
        havingParams: [1],
      });
      const havingIdx = result.sql.indexOf("HAVING");
      const limitIdx = result.sql.indexOf("LIMIT");
      const offsetIdx = result.sql.indexOf("OFFSET");
      expect(havingIdx).toBeLessThan(limitIdx);
      expect(limitIdx).toBeLessThan(offsetIdx);
      expect(result.params).toEqual([1, 10, 5]);
    });

    it("SQLite: no GROUP BY when groupBy is empty", () => {
      const result = sqliteDialect.compileSelect({
        table: "orders",
        tableAlias: "t0",
        selectList: "*",
        whereSql: "1=1",
        whereParams: [],
        orderBySql: "",
        limitNum: null,
        offsetNum: null,
        groupBy: [],
      });
      expect(result.sql).not.toContain("GROUP BY");
    });

    it("SQLite: no HAVING when havingSql is absent", () => {
      const result = sqliteDialect.compileSelect({
        table: "orders",
        tableAlias: "t0",
        selectList: "*",
        whereSql: "1=1",
        whereParams: [],
        orderBySql: "",
        limitNum: null,
        offsetNum: null,
      });
      expect(result.sql).not.toContain("HAVING");
    });
  });

  describe("distinct() wrapper in aggregates", () => {
    it("COUNT(DISTINCT col) compiles correctly in SQLite", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "COUNT",
            arg: { kind: "column", alias: "t0", column: ["category"] },
            alias: "unique",
            distinct: true,
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "category"], sqliteDialect);
      expect(sql).toContain("COUNT(DISTINCT ");
      expect(sql).toContain('"category"');
      expect(sql).toContain('AS "unique"');
    });

    it("SUM(DISTINCT col) compiles correctly", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "SUM",
            arg: { kind: "column", alias: "t0", column: ["price"] },
            alias: "total",
            distinct: true,
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "price"], sqliteDialect);
      expect(sql).toContain("SUM(DISTINCT ");
      expect(sql).toContain('"price"');
    });

    it("AVG(DISTINCT col) compiles correctly", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "AVG",
            arg: { kind: "column", alias: "t0", column: ["price"] },
            alias: "avg",
            distinct: true,
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "price"], sqliteDialect);
      expect(sql).toContain("AVG(DISTINCT ");
    });

    it("runtime parser: count(distinct(p.category)) produces distinct aggregate", async () => {
      const { parseArrowToIrSelect } = await import("../../src/parser/parse-arrow.js");
      const fn = Object.assign(() => {}, {
        toString: () => "(p) => ({ unique: count(distinct(p.category)) })",
      });
      const ir = parseArrowToIrSelect(fn as any);
      expect(ir?.aggregates?.[0]?.distinct).toBe(true);
      expect(ir?.aggregates?.[0]?.func).toBe("COUNT");
    });
  });

  describe("GROUP_CONCAT / groupConcat", () => {
    it("SQLite: GROUP_CONCAT without separator", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "GROUP_CONCAT",
            arg: { kind: "column", alias: "t0", column: ["name"] },
            alias: "names",
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "name"], sqliteDialect);
      expect(sql).toContain("GROUP_CONCAT(");
      expect(sql).toContain('"name"');
      expect(sql).toContain('AS "names"');
    });

    it("SQLite: GROUP_CONCAT with separator", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "GROUP_CONCAT",
            arg: { kind: "column", alias: "t0", column: ["name"] },
            alias: "names",
            separator: ", ",
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "name"], sqliteDialect);
      expect(sql).toContain("GROUP_CONCAT(");
      expect(sql).toContain("', '");
    });

    it("PostgreSQL: GROUP_CONCAT maps to STRING_AGG", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "GROUP_CONCAT",
            arg: { kind: "column", alias: "t0", column: ["name"] },
            alias: "names",
            separator: ", ",
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "name"], postgresDialect);
      expect(sql).toContain("STRING_AGG(");
      expect(sql).not.toContain("GROUP_CONCAT");
    });

    it("runtime parser: groupConcat(p.name, ', ') produces GROUP_CONCAT with separator", async () => {
      const { parseArrowToIrSelect } = await import("../../src/parser/parse-arrow.js");
      const fn = Object.assign(() => {}, {
        toString: () => `(p) => ({ names: groupConcat(p.name, ", ") })`,
      });
      const ir = parseArrowToIrSelect(fn as any);
      expect(ir?.aggregates?.[0]?.func).toBe("GROUP_CONCAT");
      expect(ir?.aggregates?.[0]?.separator).toBe(", ");
    });
  });

  describe("PostgreSQL-specific aggregates (STRING_AGG, ARRAY_AGG, JSON_AGG)", () => {
    it("STRING_AGG with separator compiles correctly", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "STRING_AGG",
            arg: { kind: "column", alias: "t0", column: ["name"] },
            alias: "names",
            separator: ", ",
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id", "name"], postgresDialect);
      expect(sql).toContain("STRING_AGG(");
      expect(sql).toContain("', '");
      expect(sql).toContain('AS "names"');
    });

    it("ARRAY_AGG compiles correctly", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "ARRAY_AGG",
            arg: { kind: "column", alias: "t0", column: ["id"] },
            alias: "ids",
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["id"], postgresDialect);
      expect(sql).toContain("ARRAY_AGG(");
      expect(sql).toContain('"id"');
      expect(sql).toContain('AS "ids"');
    });

    it("JSON_AGG compiles correctly", () => {
      const items: SelectItem[] = [
        {
          expr: {
            kind: "aggregate",
            func: "JSON_AGG",
            arg: { kind: "column", alias: "t0", column: ["category"] },
            alias: "cats",
          } as ExprAggregate,
        },
      ];
      const { sql } = compileItems(items, ["category"], postgresDialect);
      expect(sql).toContain("JSON_AGG(");
      expect(sql).toContain('AS "cats"');
    });

    it("runtime parser: stringAgg(p.name, ', ') produces STRING_AGG with separator", async () => {
      const { parseArrowToIrSelect } = await import("../../src/parser/parse-arrow.js");
      const fn = Object.assign(() => {}, {
        toString: () => `(p) => ({ names: stringAgg(p.name, ", ") })`,
      });
      const ir = parseArrowToIrSelect(fn as any);
      expect(ir?.aggregates?.[0]?.func).toBe("STRING_AGG");
      expect(ir?.aggregates?.[0]?.separator).toBe(", ");
    });

    it("runtime parser: arrayAgg(p.id) produces ARRAY_AGG", async () => {
      const { parseArrowToIrSelect } = await import("../../src/parser/parse-arrow.js");
      const fn = Object.assign(() => {}, { toString: () => `(p) => ({ ids: arrayAgg(p.id) })` });
      const ir = parseArrowToIrSelect(fn as any);
      expect(ir?.aggregates?.[0]?.func).toBe("ARRAY_AGG");
    });

    it("runtime parser: jsonAgg(p.category) produces JSON_AGG", async () => {
      const { parseArrowToIrSelect } = await import("../../src/parser/parse-arrow.js");
      const fn = Object.assign(() => {}, {
        toString: () => `(p) => ({ cats: jsonAgg(p.category) })`,
      });
      const ir = parseArrowToIrSelect(fn as any);
      expect(ir?.aggregates?.[0]?.func).toBe("JSON_AGG");
    });
  });

  describe(".orderBy() aggregate error message", () => {
    it("throws a specific error when ordering by an aggregate lambda", () => {
      const b = newBuilder(qe);
      const fn = Object.assign(() => 0, { toString: () => "(o) => count(o.id)" });
      expect(() => b.orderBy(fn as any)).toThrow(/orderBy does not support aggregate functions/);
    });
  });

  describe("groupBy multi-column arrow form", () => {
    it("groupBy(o => [o.category, o.status]) produces GROUP BY both columns", async () => {
      await newBuilder(qe)
        .groupBy((o: InstanceType<typeof OrderEntity>) => [o.category, o.status])
        .toArray();
      const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain('"category"');
      expect(sql).toContain('"status"');
    });
  });
});

// ─── Bug-fix regression tests ────────────────────────────────────────────────

describe("compileAggregate uses ExprColumn alias directly", () => {
  it("renders the alias on ExprColumn (no resolution step)", () => {
    const agg: ExprAggregate = {
      kind: "aggregate",
      func: "SUM",
      arg: { kind: "column", alias: "t1", column: ["price"] } as ExprColumn,
      alias: "total",
    };
    const sql = compileAggregate(agg);
    expect(sql).toContain('"t1"."price"');
    expect(sql).not.toContain('"t0"');
  });

  it("relation-aliased column renders directly", () => {
    const agg: ExprAggregate = {
      kind: "aggregate",
      func: "SUM",
      arg: { kind: "column", alias: "t1", column: ["amount"] } as ExprColumn,
      alias: "total",
    };
    const sql = compileAggregate(agg);
    expect(sql).toContain('"t1"."amount"');
    expect(sql).not.toContain('"t0"');
  });

  it("SQLite GROUP_CONCAT renders with the column's alias", () => {
    const items: SelectItem[] = [
      {
        expr: {
          kind: "aggregate",
          func: "GROUP_CONCAT",
          arg: { kind: "column", alias: "t2", column: ["name"] },
          alias: "names",
        } as ExprAggregate,
      },
    ];
    const { sql } = compileItems(items, ["name"], sqliteDialect, "t2");
    expect(sql).toContain('"t2"."name"');
    expect(sql).not.toContain('"t0"');
  });

  it("PostgreSQL STRING_AGG renders with the column's alias", () => {
    const items: SelectItem[] = [
      {
        expr: {
          kind: "aggregate",
          func: "STRING_AGG",
          arg: { kind: "column", alias: "t2", column: ["name"] },
          alias: "names",
          separator: ", ",
        } as ExprAggregate,
      },
    ];
    const { sql } = compileItems(items, ["name"], postgresDialect, "t2");
    expect(sql).toContain('"t2"."name"');
    expect(sql).not.toContain('"t0"');
  });
});

describe("Bug fix: JSON_AGG respects DISTINCT flag", () => {
  it("PostgreSQL JSON_AGG with distinct:true emits JSON_AGG(DISTINCT ...)", () => {
    const items: SelectItem[] = [
      {
        expr: {
          kind: "aggregate",
          func: "JSON_AGG",
          arg: { kind: "column", alias: "t0", column: ["category"] },
          alias: "cats",
          distinct: true,
        } as ExprAggregate,
      },
    ];
    const { sql } = compileItems(items, ["category"], postgresDialect);
    expect(sql).toContain("JSON_AGG(DISTINCT ");
  });

  it("PostgreSQL JSON_AGG without distinct emits JSON_AGG(...) without DISTINCT", () => {
    const items: SelectItem[] = [
      {
        expr: {
          kind: "aggregate",
          func: "JSON_AGG",
          arg: { kind: "column", alias: "t0", column: ["category"] },
          alias: "cats",
        } as ExprAggregate,
      },
    ];
    const { sql } = compileItems(items, ["category"], postgresDialect);
    expect(sql).not.toContain("DISTINCT");
    expect(sql).toContain("JSON_AGG(");
  });
});

describe("Bug fix: non-member aggregate arg compiles correctly", () => {
  it("SUM with numeric const arg inlines the literal (SUM(1))", () => {
    const agg: ExprAggregate = { kind: "aggregate", func: "SUM", arg: { kind: "const", value: 1 } };
    const sql = compileAggregate(agg);
    expect(sql).toBe("SUM(1)");
    expect(sql).not.toContain("*");
  });

  it("compileAggregate with const(1) arg produces COUNT(1) not COUNT(*)", () => {
    const agg: ExprAggregate = {
      kind: "aggregate",
      func: "COUNT",
      arg: { kind: "const", value: 1 },
    };
    const sql = compileAggregate(agg);
    expect(sql).toBe("COUNT(1)");
    expect(sql).not.toContain("*");
  });

  it("SUM with param arg compiles correctly via compileWhereExpr", () => {
    // SUM(:factor) > 100 — Expr.param arg requires a compileNodeFn,
    // available when the aggregate is nested inside a HAVING/WHERE walk.
    const havingExpr: Expr = {
      kind: "binary",
      op: ">",
      left: {
        kind: "aggregate",
        func: "SUM",
        arg: { kind: "param", name: "factor" },
      } as ExprAggregate,
      right: { kind: "const", value: 100 },
    };
    const result = compileWhereExpr(havingExpr, sqliteDialect);
    expect(result.sql).toContain("SUM(");
    expect(result.sql).not.toContain("SUM(*)");
    expect(result.params).toContain(100);
  });

  it("compileAggregate with param arg throws without compileNodeFn", () => {
    const agg: ExprAggregate = {
      kind: "aggregate",
      func: "SUM",
      arg: { kind: "param", name: "x" },
    };
    expect(() => compileAggregate(agg)).toThrow(/requires a compile context/);
  });
});

describe("Bug fix: GROUP BY paths via GroupByItem", () => {
  it("SQLite: index-style groupBy emits GROUP BY 1", () => {
    const result = sqliteDialect.compileSelect({
      table: "orders",
      tableAlias: "t0",
      selectList: '"t0"."category"',
      whereSql: "1=1",
      whereParams: [],
      orderBySql: "",
      limitNum: null,
      offsetNum: null,
      groupBy: [{ kind: "index", index: 1 }],
    });
    expect(result.sql).toContain("GROUP BY 1");
  });

  it("SQLite: column-style groupBy emits the resolved column", () => {
    const result = sqliteDialect.compileSelect({
      table: "orders",
      tableAlias: "t0",
      selectList: '"t0"."category"',
      whereSql: "1=1",
      whereParams: [],
      orderBySql: "",
      limitNum: null,
      offsetNum: null,
      groupBy: [{ kind: "column", alias: "t0", column: ["category"] }],
    });
    expect(result.sql).toContain('"t0"."category"');
    expect(result.sql).not.toContain('"t0"."category"."category"');
  });

  it("PostgreSQL: relation-aliased GROUP BY column", () => {
    const result = postgresDialect.compileSelect({
      table: "orders",
      tableAlias: "t0",
      selectList: '"t0"."category"',
      whereSql: "1=1",
      whereParams: [],
      orderBySql: "",
      limitNum: null,
      offsetNum: null,
      groupBy: [{ kind: "column", alias: "t1", column: ["col"] }],
    });
    expect(result.sql).toContain('"t1"."col"');
  });
});

describe("Bug fix: groupBy(fn) throws when no paths resolved", () => {
  it("throws when lambda returns a non-member expression (empty path list)", () => {
    const qe = createMockQe();
    const b = newBuilder(qe);
    const fn = Object.assign(() => null, { toString: () => "(o) => null" });
    expect(() => b.groupBy(fn as any)).toThrow(/no column paths were resolved/);
  });
});

describe("Bug fix: groupBy() defaults SELECT to groupBy paths when no prior .select()", () => {
  it("includes groupBy columns in SELECT list when no .select() was called", async () => {
    const qe = createMockQe();
    await newBuilder(qe).groupBy("category").toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toMatch(/SELECT.*"category".*FROM/s);
    expect(sql).toContain("GROUP BY");
  });

  it("preserves explicit .select() paths when groupBy is called after", async () => {
    const qe = createMockQe();
    const selectIr: IrSelect = {
      param: "u",
      paths: [["category"], ["price"]],
      aliases: ["category", "price"],
    };
    await newBuilder(qe).select(selectIr).groupBy("category").toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('"price"');
    expect(sql).toContain('"category"');
  });
});

describe("GROUP BY: positional references (GROUP BY 1, 2)", () => {
  it("SQLite: indexed groupBy emits GROUP BY 1, 2", () => {
    const result = sqliteDialect.compileSelect({
      table: "orders",
      tableAlias: "t0",
      selectList: '"t0"."category", COUNT(*)',
      whereSql: "1=1",
      whereParams: [],
      orderBySql: "",
      limitNum: null,
      offsetNum: null,
      groupBy: [
        { kind: "index", index: 1 },
        { kind: "index", index: 2 },
      ],
    });
    expect(result.sql).toContain("GROUP BY 1, 2");
  });

  it("PostgreSQL: indexed groupBy emits GROUP BY 1", () => {
    const result = postgresDialect.compileSelect({
      table: "orders",
      tableAlias: "t0",
      selectList: '"t0"."category", COUNT(*)',
      whereSql: "1=1",
      whereParams: [],
      orderBySql: "",
      limitNum: null,
      offsetNum: null,
      groupBy: [{ kind: "index", index: 1 }],
    });
    expect(result.sql).toContain("GROUP BY 1");
  });

  it("mixed: column ref + positional", () => {
    const result = sqliteDialect.compileSelect({
      table: "orders",
      tableAlias: "t0",
      selectList: '"t0"."category", COUNT(*)',
      whereSql: "1=1",
      whereParams: [],
      orderBySql: "",
      limitNum: null,
      offsetNum: null,
      groupBy: [
        { kind: "column", alias: "t0", column: ["category"] },
        { kind: "index", index: 2 },
      ],
    });
    expect(result.sql).toContain('"t0"."category", 2');
  });

  it("runtime parser: () => 1 produces positional entry", async () => {
    const { parseArrowToGroupByPaths } = await import("../../src/parser/parse-arrow.js");
    const fn = Object.assign(() => 1, { toString: () => "() => 1" });
    expect(parseArrowToGroupByPaths(fn)).toEqual([1]);
  });

  it("runtime parser: o => [1, 2] produces positional entries", async () => {
    const { parseArrowToGroupByPaths } = await import("../../src/parser/parse-arrow.js");
    const fn = Object.assign(() => [1, 2], { toString: () => "(o) => [1, 2]" });
    expect(parseArrowToGroupByPaths(fn)).toEqual([1, 2]);
  });

  it("runtime parser: o => [o.category, 1] mixes path and positional", async () => {
    const { parseArrowToGroupByPaths } = await import("../../src/parser/parse-arrow.js");
    const fn = Object.assign(() => {}, { toString: () => "(o) => [o.category, 1]" });
    expect(parseArrowToGroupByPaths(fn)).toEqual([["category"], 1]);
  });

  it("QueryBuilder: groupBy(1) produces positional GROUP BY SQL", async () => {
    const qe = createMockQe();
    await newBuilder(qe).groupBy(1).toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("GROUP BY 1");
  });

  it("QueryBuilder: groupBy([1, 2]) produces GROUP BY 1, 2", async () => {
    const qe = createMockQe();
    await newBuilder(qe).groupBy([1, 2]).toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("GROUP BY 1, 2");
  });

  it("QueryBuilder: groupBy('1') treats numeric string as positional", async () => {
    const qe = createMockQe();
    await newBuilder(qe).groupBy("1").toArray();
    const [sql] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("GROUP BY 1");
    expect(sql).not.toContain('"1"');
  });
});

describe("compileGroupBy with GroupByItem[]", () => {
  it("renders ExprColumn-based GROUP BY", () => {
    const items: GroupByItem[] = [{ kind: "column", alias: "t1", column: ["name"] }];
    expect(compileGroupBy(items)).toBe('"t1"."name"');
  });

  it("renders main-table column when no relation alias", () => {
    const items: GroupByItem[] = [{ kind: "column", alias: "t0", column: ["name"] }];
    expect(compileGroupBy(items)).toBe('"t0"."name"');
  });

  it("mixes column ref and index", () => {
    const items: GroupByItem[] = [
      { kind: "column", alias: "t1", column: ["name"] },
      { kind: "index", index: 2 },
    ];
    expect(compileGroupBy(items)).toBe('"t1"."name", 2');
  });
});

describe("Postgres placeholder numbering: WHERE + GROUP BY + HAVING + LIMIT/OFFSET", () => {
  it("params are in correct order and placeholders don't collide", async () => {
    const qe = createMockQe("postgres");
    const havingIr = having({
      kind: "binary" as const,
      op: ">" as const,
      left: { kind: "aggregate" as const, func: "COUNT" as const, arg: null },
      right: { kind: "const" as const, value: 5 },
    });
    await newBuilder(qe)
      .where((o: InstanceType<typeof OrderEntity>) => o.status === ("active" as any))
      .groupBy("category")
      .having(havingIr)
      .limit(10)
      .offset(20)
      .toArray();

    const [sql, params] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params[0]).toBe("active");
    expect(params[1]).toBe(5);
    expect(params[2]).toBe(10);
    expect(params[3]).toBe(20);
    expect((sql.match(/\$1/g) ?? []).length).toBe(1);
    expect((sql.match(/\$2/g) ?? []).length).toBe(1);
    expect((sql.match(/\$3/g) ?? []).length).toBe(1);
    expect((sql.match(/\$4/g) ?? []).length).toBe(1);
    expect(sql).toContain("GROUP BY");
    expect(sql).toContain("HAVING");
    expect(sql).toContain("LIMIT");
    expect(sql).toContain("OFFSET");
  });

  it("HAVING-only (no WHERE param): HAVING is $1, LIMIT is $2", async () => {
    const qe = createMockQe("postgres");
    const havingIr = having({
      kind: "binary" as const,
      op: ">" as const,
      left: { kind: "aggregate" as const, func: "COUNT" as const, arg: null },
      right: { kind: "const" as const, value: 3 },
    });
    await newBuilder(qe).groupBy("category").having(havingIr).limit(5).toArray();

    const [sql, params] = (qe.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(params[0]).toBe(3);
    expect(params[1]).toBe(5);
    expect((sql.match(/\$1/g) ?? []).length).toBe(1);
    expect((sql.match(/\$2/g) ?? []).length).toBe(1);
  });
});

describe("resolveGroupByPaths", () => {
  it("number input returns positional entry", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    expect(resolveGroupByPaths(1)).toEqual([1]);
  });

  it("number array input returns positional entries", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    expect(resolveGroupByPaths([1, 2])).toEqual([1, 2]);
  });

  it("numeric string treated as positional", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    expect(resolveGroupByPaths("1")).toEqual([1]);
  });

  it("dot-separated string split into path", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    expect(resolveGroupByPaths("author.name")).toEqual([["author", "name"]]);
  });

  it("string array maps each entry", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    expect(resolveGroupByPaths(["category", "status"])).toEqual([["category"], ["status"]]);
  });

  it("varargs: string + number", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    expect(resolveGroupByPaths("category", 2)).toEqual([["category"], 2]);
  });

  it("arrow function: o => o.category produces path", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    const fn = Object.assign(() => {}, { toString: () => "(o) => o.category" });
    expect(resolveGroupByPaths(fn)).toEqual([["category"]]);
  });

  it("arrow function: () => 1 produces positional entry", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    const fn = Object.assign(() => 1, { toString: () => "() => 1" });
    expect(resolveGroupByPaths(fn)).toEqual([1]);
  });

  it("arrow function returning nothing throws", async () => {
    const { resolveGroupByPaths } = await import("../../src/parser/resolve.js");
    const fn = Object.assign(() => null, { toString: () => "(o) => null" });
    expect(() => resolveGroupByPaths(fn)).toThrow(/no column paths were resolved/);
  });
});

describe("Bug fix: distinct flag only set when inner arg resolves in transformers", () => {
  it("runtime parser: count(distinct(nonMember)) throws rather than producing COUNT(DISTINCT *)", async () => {
    const { parseArrowToIr } = await import("../../src/parser/parse-arrow.js");
    const fn = Object.assign(() => true, {
      toString: () => "(o) => count(distinct(someFunc())) > 0",
    });
    expect(() => parseArrowToIr(fn as any, {})).toThrow(/DISTINCT/i);
  });

  it("runtime parser: count(distinct(p.col)) still produces distinct:true", async () => {
    const { parseArrowToIrSelect } = await import("../../src/parser/parse-arrow.js");
    const fn = Object.assign(() => {}, {
      toString: () => "(p) => ({ n: count(distinct(p.category)) })",
    });
    const ir = parseArrowToIrSelect(fn as any);
    expect(ir?.aggregates?.[0]?.distinct).toBe(true);
    expect(ir?.aggregates?.[0]?.arg).not.toBeNull();
  });
});
