import { describe, it, expect, vi, beforeEach } from "vitest";
import { Table } from "../../src/orm/table.js";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import type { Driver } from "../../src/driver/types.js";
import { getColumnNames } from "../../src/schema/types.js";
import type { IrNode } from "../../src/ir/types.js";

type MockEntity = { id?: number; name?: string; };

function createMockDriver(): Driver {
  return {
    query: vi.fn().mockReturnValue([]),
    run: vi.fn().mockReturnValue({ lastID: 1, changes: 1 }),
    transaction: vi.fn((fn) => fn()),
    close: vi.fn(),
  };
}

describe("Table", () => {
  let driver: Driver;

  beforeEach(() => {
    driver = createMockDriver();
  });

  it("exposes columnNames from definition", () => {
    const def = { id: "integer", name: "text", age: "integer" };
    const table = new Table<MockEntity>("users", def, driver);
    expect(table.columnNames).toEqual(getColumnNames(def));
  });

  it("where returns QueryBuilder", () => {
    const table = new Table<MockEntity>("users", { id: "integer", name: "text" }, driver);
    const q = table.where((u) => u.id === 1);
    expect(q).toBeInstanceOf(QueryBuilder);
    const rows = q.toArray();
    expect(driver.query).toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("query returns QueryBuilder", () => {
    const table = new Table("users", { id: "integer" }, driver);
    const q = table.query();
    expect(q).toBeInstanceOf(QueryBuilder);
    const ir: IrNode = {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "u", path: ["id"] },
      right: { kind: "const", value: 1 },
    };
    const rows = q.where(ir).toArray();
    expect(driver.query).toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("insert builds INSERT and calls driver.run", () => {
    const table = new Table("users", { id: "integer", name: "text" }, driver);
    table.insert({ name: "Alice" });
    expect(driver.run).toHaveBeenCalled();
    const [sql, params] = (driver.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("INSERT");
    expect(params).toContain("Alice");
  });

  it("findById uses primary key and returns first", () => {
    const table = new Table("users", { id: "integer primary key", name: "text" }, driver);
    (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ id: 1, name: "Alice" }]);
    const row = table.findById(1);
    expect(row).toEqual({ id: 1, name: "Alice" });
  });

  it("findById returns undefined when not found", () => {
    const table = new Table("users", { id: "integer primary key" }, driver);
    (driver.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
    expect(table.findById(999)).toBeUndefined();
  });

  it("update chains where and calls run", () => {
    const table = new Table<MockEntity>("users", { id: "integer", name: "text" }, driver);
    const n = table.update(u => u.id === 1, { name: "Updated" });
    expect(driver.run).toHaveBeenCalled();
    expect(n).toBe(1);
  });

  it("delete chains where and calls run", () => {
    const table = new Table<MockEntity>("users", { id: "integer" }, driver);
    const n = table.delete(u => u.id === 1);
    expect(driver.run).toHaveBeenCalled();
    expect(n).toBe(1);
  });
});
