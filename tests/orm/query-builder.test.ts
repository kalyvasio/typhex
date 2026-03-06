import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import { whereColumnEq } from "../../src/orm/query-helpers.js";
import type { Driver } from "../../src/driver/types.js";
import type { IrNode, IrSelect } from "../../src/ir/types.js";
import { isIrSelect } from "../../src/ir/types.js";

type MockEntity = { id?: number; name?: string; age: number; country: string };

function createMockDriver(): Driver {
  return {
    dialect: "sqlite",
    query: vi.fn().mockReturnValue([]),
    run: vi.fn().mockReturnValue({ lastID: 1, changes: 0 }),
    transaction: vi.fn((fn) => fn()),
    close: vi.fn(),
  };
}

function newBuilder(driver: Driver, columnNames = ["id", "name", "age"]): QueryBuilder<MockEntity> {
  return new QueryBuilder<MockEntity>({
    tableName: "users",
    columnNames,
    driver,
    whereIr: null,
    whereParams: {},
    orderBy: [],
    limitNum: null,
    offsetNum: null,
    selectIr: null,
  });
}

describe("QueryBuilder", () => {
  let driver: Driver;

  beforeEach(() => {
    driver = createMockDriver();
  });

  describe("where", () => {
    it("accepts IR predicate and chains", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      const q = newBuilder(driver).where(ir);
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("accepts arrow and parses to IR", () => {
      const q = newBuilder(driver).where((u: { age: number }) => u.age > 18);
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("merges params when provided", () => {
      const q = newBuilder(driver).where(
        (u: { country: string }) => u.country === "US",
        { country: "US" }
      );
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("throws when arrow cannot be parsed", () => {
      const badFn = (_u: { x: number }) => {
        return (window as unknown as { y: number }).y > 1;
      };
      expect(() => newBuilder(driver).where(badFn as (u: { x: number }) => boolean)).toThrow(
        "Failed to parse arrow predicate"
      );
    });
  });

  describe("orderBy", () => {
    it("chains with default asc", () => {
      const q = newBuilder(driver).orderBy("name");
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("chains with desc", () => {
      const q = newBuilder(driver).orderBy("age", "desc");
      expect(q).toBeInstanceOf(QueryBuilder);
    });
  });

  describe("clone", () => {
    it("returns a new QueryBuilder with copied state", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      const base = newBuilder(driver).where(ir).limit(5);
      const cloned = base.clone();
      expect(cloned).toBeInstanceOf(QueryBuilder);
      expect(cloned).not.toBe(base);
      cloned.limit(10);
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      await base.toArray();
      const [sqlBase, paramsBase] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sqlBase).toContain("LIMIT ?");
      expect(paramsBase).toContain(5);
      await cloned.toArray();
      const [sqlCloned, paramsCloned] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(sqlCloned).toContain("LIMIT ?");
      expect(paramsCloned).toContain(10);
    });
  });

  describe("limit / offset", () => {
    it("limit chains and returns this", () => {
      const q = newBuilder(driver);
      expect(q.limit(10)).toBe(q);
    });

    it("offset chains and returns this", () => {
      const q = newBuilder(driver);
      expect(q.offset(5)).toBe(q);
    });
  });

  describe("select", () => {
    it("accepts column names and returns this", () => {
      const q = newBuilder(driver);
      expect(q.select(["id", "name"])).toBe(q);
    });

    it("accepts IrSelect and uses it in SQL", async () => {
      const selectIr: IrSelect = { param: "u", paths: [["id"], ["name"]] };
      await newBuilder(driver).select(selectIr).toArray();
      expect(driver.query).toHaveBeenCalled();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
      expect(sql).toContain('"t0"."name"');
      expect(sql).not.toContain('"t0"."age"');
    });

    it("accepts IrSelect with aliases and emits AS in SQL", async () => {
      const selectIr: IrSelect = {
        param: "u",
        paths: [["id"], ["name"]],
        aliases: ["userId", "fullName"],
      };
      await newBuilder(driver).select(selectIr).toArray();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('AS "userId"');
      expect(sql).toContain('AS "fullName"');
    });

    it("accepts IrSelect with rest and includes remaining columns", async () => {
      const selectIr: IrSelect = { param: "u", paths: [["id"]], rest: true };
      await newBuilder(driver).select(selectIr).toArray();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
      expect(sql).toContain('"t0"."name"');
      expect(sql).toContain('"t0"."age"');
    });

    it("treats plain object with param and paths as IrSelect", async () => {
      const selectIr = { param: "u", paths: [["id"]] };
      expect(isIrSelect(selectIr)).toBe(true);
      await newBuilder(driver).select(selectIr as IrSelect).toArray();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
    });
  });

  describe("insert", () => {
    it("builds INSERT and calls driver.run", async () => {
      await newBuilder(driver).insert({ name: "Alice" });
      expect(driver.run).toHaveBeenCalled();
      const [sql, params] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("INSERT");
      expect(params).toContain("Alice");
    });

    it("returns lastID from driver", async () => {
      (driver.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 42, changes: 1 });
      const id = await newBuilder(driver).insert({ name: "Bob" });
      expect(id).toBe(42);
    });

    it("uses DEFAULT VALUES when all fields are undefined", async () => {
      await newBuilder(driver).insert({ id: undefined, name: undefined, age: undefined } as unknown as Record<string, unknown>);
      const [sql, params] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("DEFAULT VALUES");
      expect(params).toEqual([]);
    });
  });

  describe("toArray", () => {
    it("builds SELECT and calls driver.query", async () => {
      await newBuilder(driver).toArray();
      expect(driver.query).toHaveBeenCalled();
      const [sql] = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("SELECT");
      expect(sql).toContain("FROM");
      expect(sql).toContain("WHERE");
    });

    it("with where IR uses parameterized SQL", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 42 },
      };
      await newBuilder(driver).where(ir).toArray();
      expect(driver.query).toHaveBeenCalledWith(
        expect.stringContaining("?"),
        [42]
      );
    });
  });

  describe("first", () => {
    it("returns first row when driver returns one", async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ id: 1, name: "a" }]);
      const row = await newBuilder(driver).first();
      expect(row).toEqual({ id: 1, name: "a" });
    });

    it("returns undefined when no rows", async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const row = await newBuilder(driver).first();
      expect(row).toBeUndefined();
    });
  });

  describe("count", () => {
    it("calls driver with COUNT query", async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ c: 5 }]);
      const n = await newBuilder(driver).count();
      expect(n).toBe(5);
    });

    it("returns 0 when no rows", async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      expect(await newBuilder(driver).count()).toBe(0);
    });
  });

  describe("update", () => {
    it("calls driver.run with UPDATE SQL", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      await newBuilder(driver).where(ir).update({ name: "Updated" });
      expect(driver.run).toHaveBeenCalled();
      const [sql] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("SET");
    });
  });

  describe("delete", () => {
    it("calls driver.run with DELETE SQL", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      await newBuilder(driver).where(ir).delete();
      expect(driver.run).toHaveBeenCalled();
      const [sql] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("DELETE");
    });
  });

  describe("where().first() (pk lookup)", () => {
    function newBuilderWithPk(d: Driver): QueryBuilder<MockEntity> {
      return new QueryBuilder<MockEntity>({
        tableName: "users",
        columnNames: ["id", "name", "age"],
        driver: d,
        pkColumn: "id",
        whereIr: null,
        whereParams: {},
        orderBy: [],
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      });
    }

    it("returns row when found", async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ id: 1, name: "Alice", age: 30 }]);
      const row = await newBuilderWithPk(driver).where(whereColumnEq("id", 1)).first();
      expect(row).toEqual({ id: 1, name: "Alice", age: 30 });
    });

    it("returns undefined when not found", async () => {
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const row = await newBuilderWithPk(driver).where(whereColumnEq("id", 999)).first();
      expect(row).toBeUndefined();
    });
  });

  describe("where().update() (pk update)", () => {
    function newBuilderWithPk(d: Driver): QueryBuilder<MockEntity> {
      return new QueryBuilder<MockEntity>({
        tableName: "users",
        columnNames: ["id", "name", "age"],
        driver: d,
        pkColumn: "id",
        whereIr: null,
        whereParams: {},
        orderBy: [],
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      });
    }

    it("builds UPDATE ... WHERE pk = ? SQL", async () => {
      (driver.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 0, changes: 1 });
      const changes = await newBuilderWithPk(driver).where(whereColumnEq("id", 1)).update({ name: "Updated" });
      expect(changes).toBe(1);
      const [sql, params] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('UPDATE "users"');
      expect(sql).toContain('"name" = ?');
      expect(sql).toMatch(/"id"\s*=\s*\?/);
      expect(params).toEqual(["Updated", 1]);
    });

    it("returns 0 when set is empty", async () => {
      const changes = await newBuilderWithPk(driver).where(whereColumnEq("id", 1)).update({});
      expect(changes).toBe(0);
      expect(driver.run).not.toHaveBeenCalled();
    });
  });

  describe("where().delete() (pk delete)", () => {
    function newBuilderWithPk(d: Driver): QueryBuilder<MockEntity> {
      return new QueryBuilder<MockEntity>({
        tableName: "users",
        columnNames: ["id", "name", "age"],
        driver: d,
        pkColumn: "id",
        whereIr: null,
        whereParams: {},
        orderBy: [],
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      });
    }

    it("builds DELETE ... WHERE pk = ? SQL", async () => {
      (driver.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 0, changes: 1 });
      const changes = await newBuilderWithPk(driver).where(whereColumnEq("id", 5)).delete();
      expect(changes).toBe(1);
      const [sql, params] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('DELETE FROM "users"');
      expect(sql).toMatch(/"id"\s*=\s*\?/);
      expect(params).toEqual([5]);
    });
  });

  describe("patch", () => {
    it("updates and re-fetches the row", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      (driver.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 0, changes: 1 });
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ id: 1, name: "Updated", age: 30 }]);
      const row = await newBuilder(driver).where(ir).patch({ name: "Updated" });
      expect(row).toEqual({ id: 1, name: "Updated", age: 30 });
      expect(driver.run).toHaveBeenCalled();
      expect(driver.query).toHaveBeenCalled();
    });

    it("returns null when row disappears after update", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      (driver.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 0, changes: 1 });
      (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const row = await newBuilder(driver).where(ir).patch({ name: "Gone" });
      expect(row).toBeNull();
    });
  });
});
