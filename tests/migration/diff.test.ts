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

  afterEach(async () => {
    await driver.close();
  });

  it("detects new table (add_table)", async () => {
    const entities = [entity("users", { id: "integer primary key", name: "text not null" })];
    const actions = await diffSchema(driver, entities);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("add_table");
    expect(actions[0].table).toBe("users");
  });

  it("detects no changes when schema matches", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "name" text not null)`);
    const entities = [entity("users", { id: "integer primary key", name: "text not null" })];
    const actions = await diffSchema(driver, entities);
    expect(actions).toHaveLength(0);
  });

  it("detects added column", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "name" text)`);
    const entities = [entity("users", { id: "integer primary key", name: "text", age: "integer" })];
    const actions = await diffSchema(driver, entities);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("add_column");
    if (actions[0].kind === "add_column") {
      expect(actions[0].column).toBe("age");
      expect(actions[0].definition).toBe("integer");
    }
  });

  it("detects dropped column", async () => {
    await driver.execute(
      `CREATE TABLE "users" ("id" integer primary key, "name" text, "legacy" text)`,
    );
    const entities = [entity("users", { id: "integer primary key", name: "text" })];
    const actions = await diffSchema(driver, entities);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("drop_column");
    if (actions[0].kind === "drop_column") {
      expect(actions[0].column).toBe("legacy");
    }
  });

  it("detects dropped table", async () => {
    await driver.execute(`CREATE TABLE "old_table" ("id" integer primary key)`);
    const actions = await diffSchema(driver, []);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("drop_table");
    expect(actions[0].table).toBe("old_table");
  });

  it("detects altered column type", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "age" text)`);
    const entities = [entity("users", { id: "integer primary key", age: "integer" })];
    const actions = await diffSchema(driver, entities);
    expect(actions.some((a) => a.kind === "alter_column")).toBe(true);
  });

  it("detects nullability drift", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "email" text)`);
    const entities = [entity("users", { id: "integer primary key", email: "text not null" })];
    const actions = await diffSchema(driver, entities);
    const alter = actions.find(
      (a) => a.kind === "alter_column" && a.table === "users" && a.column === "email",
    );
    expect(alter).toBeDefined();
    if (alter?.kind !== "alter_column") throw new Error("expected alter_column");
    expect(alter.columnInfo.notnull).toBe(0);
    expect(alter.changes).toContainEqual({ kind: "not_null", from: false, to: true });
  });

  it("detects default drift", async () => {
    await driver.execute(
      `CREATE TABLE "users" ("id" integer primary key, "active" integer default 0)`,
    );
    const entities = [entity("users", { id: "integer primary key", active: "integer default 1" })];
    const actions = await diffSchema(driver, entities);
    const alter = actions.find(
      (a) => a.kind === "alter_column" && a.table === "users" && a.column === "active",
    );
    expect(alter).toBeDefined();
    if (alter?.kind !== "alter_column") throw new Error("expected alter_column");
    expect(alter.columnInfo.dflt_value).toBe("0");
    expect(alter.changes).toContainEqual({ kind: "default", from: "0", to: "1" });
  });

  it("detects case-sensitive string default drift", async () => {
    await driver.execute(
      `CREATE TABLE "users" ("id" integer primary key, "name" text default 'Anon')`,
    );
    const entities = [entity("users", { id: "integer primary key", name: "text default 'anon'" })];
    const actions = await diffSchema(driver, entities);
    const alter = actions.find(
      (a) => a.kind === "alter_column" && a.table === "users" && a.column === "name",
    );
    expect(alter).toBeDefined();
    if (alter?.kind !== "alter_column") throw new Error("expected alter_column");
    expect(alter.columnInfo.dflt_value).toBe("'Anon'");
    expect(alter.changes).toContainEqual({ kind: "default", from: "'Anon'", to: "'anon'" });
  });

  it("treats possible column renames as add/drop changes", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "full_name" text)`);
    const entities = [entity("users", { id: "integer primary key", name: "text" })];
    const actions = await diffSchema(driver, entities);
    expect(actions).toHaveLength(2);
    expect(actions).toContainEqual({
      kind: "add_column",
      table: "users",
      column: "name",
      definition: "text",
    });
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "drop_column", table: "users", column: "full_name" }),
    );
  });

  it("handles multiple tables with mixed changes", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "name" text)`);
    const entities = [
      entity("users", { id: "integer primary key", name: "text", email: "text" }),
      entity("posts", { id: "integer primary key", title: "text" }),
    ];
    const actions = await diffSchema(driver, entities);
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toContain("add_column");
    expect(kinds).toContain("add_table");
  });

  it("ignores _typhex_migrations table", async () => {
    await driver.execute(
      `CREATE TABLE "_typhex_migrations" ("id" integer primary key, "name" text)`,
    );
    const actions = await diffSchema(driver, []);
    expect(actions).toHaveLength(0);
  });
});
