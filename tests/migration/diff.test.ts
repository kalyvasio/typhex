import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import type { Driver } from "../../src/driver/types.js";
import { diffSchema } from "../../src/migration/diff.js";
import type { RegisteredEntity } from "../../src/entity/global-driver.js";

function entity(table: string, schema: Record<string, string>): RegisteredEntity {
  return { table: { _table: table, _schema: schema } };
}

describe("diffSchema", () => {
  let driver: Driver;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
  });

  afterEach(() => {
    driver.close();
  });

  it("detects new table (add_table)", () => {
    const entities = [entity("users", { id: "integer primary key", name: "text not null" })];
    const actions = diffSchema(driver, entities);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("add_table");
    expect(actions[0].table).toBe("users");
  });

  it("detects no changes when schema matches", () => {
    driver.run(`CREATE TABLE "users" ("id" integer primary key, "name" text not null)`);
    const entities = [entity("users", { id: "integer primary key", name: "text not null" })];
    const actions = diffSchema(driver, entities);
    expect(actions).toHaveLength(0);
  });

  it("detects added column", () => {
    driver.run(`CREATE TABLE "users" ("id" integer primary key, "name" text)`);
    const entities = [entity("users", { id: "integer primary key", name: "text", age: "integer" })];
    const actions = diffSchema(driver, entities);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("add_column");
    if (actions[0].kind === "add_column") {
      expect(actions[0].column).toBe("age");
      expect(actions[0].definition).toBe("integer");
    }
  });

  it("detects dropped column", () => {
    driver.run(`CREATE TABLE "users" ("id" integer primary key, "name" text, "legacy" text)`);
    const entities = [entity("users", { id: "integer primary key", name: "text" })];
    const actions = diffSchema(driver, entities);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("drop_column");
    if (actions[0].kind === "drop_column") {
      expect(actions[0].column).toBe("legacy");
    }
  });

  it("detects dropped table", () => {
    driver.run(`CREATE TABLE "old_table" ("id" integer primary key)`);
    const actions = diffSchema(driver, []);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("drop_table");
    expect(actions[0].table).toBe("old_table");
  });

  it("detects altered column type", () => {
    driver.run(`CREATE TABLE "users" ("id" integer primary key, "age" text)`);
    const entities = [entity("users", { id: "integer primary key", age: "integer" })];
    const actions = diffSchema(driver, entities);
    expect(actions.some((a) => a.kind === "alter_column")).toBe(true);
  });

  it("handles multiple tables with mixed changes", () => {
    driver.run(`CREATE TABLE "users" ("id" integer primary key, "name" text)`);
    const entities = [
      entity("users", { id: "integer primary key", name: "text", email: "text" }),
      entity("posts", { id: "integer primary key", title: "text" }),
    ];
    const actions = diffSchema(driver, entities);
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toContain("add_column");
    expect(kinds).toContain("add_table");
  });

  it("ignores _typhex_migrations table", () => {
    driver.run(`CREATE TABLE "_typhex_migrations" ("id" integer primary key, "name" text)`);
    const actions = diffSchema(driver, []);
    expect(actions).toHaveLength(0);
  });
});
