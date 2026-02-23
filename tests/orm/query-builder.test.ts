import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import type { Table } from "../../src/orm/table.js";
import type { Driver } from "../../src/driver/types.js";
import type { IrNode, IrSelect } from "../../src/ir/types.js";
import { isIrSelect } from "../../src/ir/types.js";

/** Entity shape used in query-builder tests so predicate types like (u: { age: number }) match. */
type MockEntity = { id?: number; name?: string; age: number; country: string };

function createMockTable(
  columnNames: string[] = ["id", "name", "age"],
  driver?: Driver
): Table<MockEntity> {
  const mock = {
    tableName: "users",
    columnNames,
    definition: {},
    driver: undefined as Driver | undefined,
    query(this: typeof mock) {
      if (!this.driver) throw new Error("createMockTable: pass driver for query()");
      return new QueryBuilder({
        table: this as unknown as Table<MockEntity>,
        driver: this.driver,
        whereIr: null,
        whereParams: {},
        orderBy: [],
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      });
    },
  };
  if (driver) mock.driver = driver;
  return mock as unknown as Table<MockEntity>;
}

function createMockDriver(): Driver {
  return {
    query: vi.fn().mockReturnValue([]),
    run: vi.fn().mockReturnValue({ lastID: 1, changes: 0 }),
    transaction: vi.fn((fn) => fn()),
    close: vi.fn(),
  };
}

describe("QueryBuilder", () => {
  let driver: Driver;
  let table: Table<MockEntity>;

  beforeEach(() => {
    driver = createMockDriver();
    table = createMockTable(undefined, driver);
  });

  function newBuilder() {
    return table.query();
  }

  describe("where", () => {
    it("accepts IR predicate and chains", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      const q = newBuilder().where(ir);
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("accepts arrow and parses to IR", () => {
      const q = newBuilder().where((u: { age: number }) => u.age > 18);
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("merges params when provided", () => {
      const q = newBuilder().where(
        (u: { country: string }) => u.country === "US",
        { country: "US" }
      );
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("throws when arrow cannot be parsed", () => {
      const badFn = (_u: { x: number }) => {
        return (window as unknown as { y: number }).y > 1;
      };
      expect(() => newBuilder().where(badFn as (u: { x: number }) => boolean)).toThrow(
        "Failed to parse arrow predicate"
      );
    });
  });

  describe("orderBy", () => {
    it("chains with default asc", () => {
      const q = newBuilder().orderBy("name");
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("chains with desc", () => {
      const q = newBuilder().orderBy("age", "desc");
      expect(q).toBeInstanceOf(QueryBuilder);
    });
  });

  describe("clone", () => {
    it("returns a new QueryBuilder with copied state", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      const base = newBuilder().where(ir).limit(5);
      const cloned = base.clone();
      expect(cloned).toBeInstanceOf(QueryBuilder);
      expect(cloned).not.toBe(base);
      cloned.limit(10);
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      base.toArray();
      const [sqlBase] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sqlBase).toContain("LIMIT 5");
      cloned.toArray();
      const [sqlCloned] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(sqlCloned).toContain("LIMIT 10");
    });
  });

  describe("limit / offset", () => {
    it("limit chains and returns this", () => {
      const q = newBuilder();
      expect(q.limit(10)).toBe(q);
    });

    it("offset chains and returns this", () => {
      const q = newBuilder();
      expect(q.offset(5)).toBe(q);
    });
  });

  describe("select", () => {
    it("accepts column names and returns this", () => {
      const q = newBuilder();
      expect(q.select(["id", "name"])).toBe(q);
    });

    it("accepts IrSelect and uses it in SQL", () => {
      const selectIr: IrSelect = { param: "u", paths: [["id"], ["name"]] };
      newBuilder().select(selectIr).toArray();
      expect(driver.query).toHaveBeenCalled();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
      expect(sql).toContain('"t0"."name"');
      expect(sql).not.toContain('"t0"."age"');
    });

    it("accepts IrSelect with aliases and emits AS in SQL", () => {
      const selectIr: IrSelect = {
        param: "u",
        paths: [["id"], ["name"]],
        aliases: ["userId", "fullName"],
      };
      newBuilder().select(selectIr).toArray();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('AS "userId"');
      expect(sql).toContain('AS "fullName"');
    });

    it("accepts IrSelect with rest and includes remaining columns", () => {
      const selectIr: IrSelect = { param: "u", paths: [["id"]], rest: true };
      newBuilder().select(selectIr).toArray();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
      expect(sql).toContain('"t0"."name"');
      expect(sql).toContain('"t0"."age"');
    });

    it("treats plain object with param and paths as IrSelect", () => {
      const selectIr = { param: "u", paths: [["id"]] };
      expect(isIrSelect(selectIr)).toBe(true);
      newBuilder().select(selectIr as IrSelect).toArray();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
    });
  });

  describe("toArray", () => {
    it("builds SELECT and calls driver.query", () => {
      newBuilder().toArray();
      expect(driver.query).toHaveBeenCalled();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("SELECT");
      expect(sql).toContain("FROM");
      expect(sql).toContain("WHERE");
    });

    it("with where IR uses parameterized SQL", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 42 },
      };
      newBuilder().where(ir).toArray();
      expect(driver.query).toHaveBeenCalledWith(
        expect.stringContaining("?"),
        [42]
      );
    });
  });

  describe("first", () => {
    it("returns first row when driver returns one", () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ id: 1, name: "a" }]);
      const row = newBuilder().first();
      expect(row).toEqual({ id: 1, name: "a" });
    });

    it("returns undefined when no rows", () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const row = newBuilder().first();
      expect(row).toBeUndefined();
    });
  });

  describe("count", () => {
    it("calls driver with COUNT query", () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ c: 5 }]);
      const n = newBuilder().count();
      expect(n).toBe(5);
    });

    it("returns 0 when no rows", () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      expect(newBuilder().count()).toBe(0);
    });
  });

  describe("update", () => {
    it("calls driver.run with UPDATE SQL", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      newBuilder().where(ir).update({ name: "Updated" });
      expect(driver.run).toHaveBeenCalled();
      const [sql] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("SET");
    });
  });

  describe("delete", () => {
    it("calls driver.run with DELETE SQL", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      newBuilder().where(ir).delete();
      expect(driver.run).toHaveBeenCalled();
      const [sql] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("DELETE");
    });
  });
});
