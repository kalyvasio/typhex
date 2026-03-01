import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSqliteDriver,
  sqliteDialect,
  sqliteMigrations,
  getDialect,
} from "../../src/dbs/index.js";
import { Entity } from "../../src/entity/entity.js";
import { clearRegistry, setDefaultDriver } from "../../src/entity/global-driver.js";

describe("dbs/sqlite", () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    setDefaultDriver(null);
  });

  describe("createSqliteDriver", () => {
    it("creates a driver with async query/run", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      try {
        const rows = await driver.query("SELECT 1 as x");
        expect(rows).toEqual([{ x: 1 }]);

        await driver.run('CREATE TABLE "t" ("id" integer primary key)');
        const runResult = await driver.run('INSERT INTO "t" ("id") VALUES (1)');
        expect(runResult.changes).toBe(1);
        expect(runResult.lastID).toBe(1);
      } finally {
        await driver.close();
      }
    });

    it("supports transactions", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      try {
        await driver.run('CREATE TABLE "t" ("id" integer primary key)');
        await driver.transaction(async () => {
          await driver.run('INSERT INTO "t" ("id") VALUES (1)');
          await driver.run('INSERT INTO "t" ("id") VALUES (2)');
        });
        const rows = await driver.query('SELECT * FROM "t"');
        expect(rows).toHaveLength(2);
      } finally {
        await driver.close();
      }
    });

    it("rolls back on transaction error", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      try {
        await driver.run('CREATE TABLE "t" ("id" integer primary key)');
        await expect(
          driver.transaction(async () => {
            await driver.run('INSERT INTO "t" ("id") VALUES (1)');
            throw new Error("abort");
          })
        ).rejects.toThrow("abort");
        const rows = await driver.query('SELECT * FROM "t"');
        expect(rows).toHaveLength(0);
      } finally {
        await driver.close();
      }
    });
  });

  describe("sqliteDialect", () => {
    it("uses ? placeholders", () => {
      expect(sqliteDialect.placeholder(1)).toBe("?");
      expect(sqliteDialect.placeholder(2)).toBe("?");
    });

    it("escapes identifiers", () => {
      expect(sqliteDialect.escapeIdentifier("users")).toBe('"users"');
      expect(sqliteDialect.escapeIdentifier('a"b')).toBe('"a""b"');
    });

    it("compiles WHERE with ? placeholders", () => {
      const ir = {
        kind: "binary" as const,
        op: "===" as const,
        left: { kind: "member" as const, param: "u", path: ["age"] },
        right: { kind: "const" as const, value: 18 },
      };
      const result = sqliteDialect.compileWhere(ir, {});
      expect(result.sql).toContain("?");
      expect(result.params).toEqual([18]);
    });

    it("expandPlaceholders expands IN arrays to multiple ?", () => {
      const sql = '("t0"."id" IN (?))';
      const resolved = [[10, 20]];
      const { sql: outSql, params } = sqliteDialect.expandPlaceholders(sql, resolved);
      expect(outSql).toBe('("t0"."id" IN (?, ?))');
      expect(params).toEqual([10, 20]);
    });

    it("compileInsert produces INSERT without RETURNING", () => {
      const { sql, params } = sqliteDialect.compileInsert(
        "users",
        ["name", "age"],
        ["Alice", 30],
        "id"
      );
      expect(sql).toContain('INSERT INTO "users"');
      expect(sql).not.toContain("RETURNING");
      expect(params).toEqual(["Alice", 30]);
    });
  });

  describe("sqliteMigrations", () => {
    it("getDbTables returns table names", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      try {
        await driver.run('CREATE TABLE "foo" ("id" integer primary key)');
        const tables = await sqliteMigrations.getDbTables(driver);
        expect(tables).toContain("foo");
      } finally {
        await driver.close();
      }
    });

    it("getDbColumns returns column info", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      try {
        await driver.run(
          'CREATE TABLE "users" ("id" integer primary key, "name" text not null)'
        );
        const cols = await sqliteMigrations.getDbColumns(driver, "users");
        expect(cols.map((c) => c.name)).toEqual(["id", "name"]);
      } finally {
        await driver.close();
      }
    });

    it("generateSql produces valid DDL for add_table", () => {
      const action = {
        kind: "add_table" as const,
        table: "users",
        schema: {
          id: "integer primary key autoincrement",
          name: "text not null",
        },
      };
      const sql = sqliteMigrations.generateSql(action);
      expect(sql).toContain("CREATE TABLE");
      expect(sql).toContain('"users"');
      expect(sql).toContain("autoincrement");
    });

    it("getTrackingTableDdl produces SQLite DDL", () => {
      const ddl = sqliteMigrations.getTrackingTableDdl();
      expect(ddl).toContain("_typhex_migrations");
      expect(ddl).toContain("autoincrement");
      expect(ddl).toContain("datetime('now')");
    });

    it("getRecordMigrationSql uses ? placeholder", () => {
      const sql = sqliteMigrations.getRecordMigrationSql();
      expect(sql).toContain("INSERT INTO");
      expect(sql).toContain("?");
    });
  });

  describe("getDialect", () => {
    it("returns sqlite dialect for sqlite", () => {
      const d = getDialect("sqlite");
      expect(d.name).toBe("sqlite");
    });
  });
});
