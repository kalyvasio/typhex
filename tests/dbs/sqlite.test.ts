import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSqliteDriver,
  sqliteDialect,
  sqliteMigrations,
  getDialect,
} from "../../src/dbs/index.js";
import { clearRegistry, setDefaultDb } from "../../src/entity/global-driver.js";
import { Db } from "../../src/orm/db.js";
import { SQL_DEFAULT } from "../../src/dbs/types.js";

describe("dbs/sqlite", () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    setDefaultDb(null);
  });

  describe("createSqliteDriver", () => {
    it("creates a driver with async execute", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      try {
        const rows = await driver.execute("SELECT 1 as x").then(r => r.rows);
        expect(rows).toEqual([{ x: 1 }]);

        await driver.execute('CREATE TABLE "t" ("id" integer primary key)');
        const runResult = await driver.execute('INSERT INTO "t" ("id") VALUES (1)');
        expect(runResult.changes).toBe(1);
        expect(runResult.lastID).toBe(1);
      } finally {
        await driver.close();
      }
    });

    it("supports transactions", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      const db = new Db(driver);
      try {
        await driver.execute('CREATE TABLE "t" ("id" integer primary key)');
        await db.transaction(async () => {
          await db.run('INSERT INTO "t" ("id") VALUES (1)');
          await db.run('INSERT INTO "t" ("id") VALUES (2)');
        });
        const rows = await driver.execute('SELECT * FROM "t"').then(r => r.rows);
        expect(rows).toHaveLength(2);
      } finally {
        await db.close();
      }
    });

    it("rolls back on transaction error", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      const db = new Db(driver);
      try {
        await driver.execute('CREATE TABLE "t" ("id" integer primary key)');
        await expect(
          db.transaction(async () => {
            await db.run('INSERT INTO "t" ("id") VALUES (1)');
            throw new Error("abort");
          })
        ).rejects.toThrow("abort");
        const rows = await driver.execute('SELECT * FROM "t"').then(r => r.rows);
        expect(rows).toHaveLength(0);
      } finally {
        await db.close();
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

    it("compiles WHERE with relation path when relationPathToAlias provided", () => {
      const ir = {
        kind: "binary" as const,
        op: "===" as const,
        left: { kind: "member" as const, param: "c", path: ["company", "name"] },
        right: { kind: "const" as const, value: "Acme" },
      };
      const result = sqliteDialect.compileWhere(ir, {
        relationPathToAlias: { "c.company": "t1" },
      });
      expect(result.sql).toContain('"t1"."name"');
      expect(result.params).toEqual(["Acme"]);
    });

    it("compileSelect emits LEFT JOIN for relation joins", () => {
      const result = sqliteDialect.compileSelect({
        table: "contacts",
        selectList: '"t0"."id", "t1"."name" AS "company_name"',
        whereSql: "1=1",
        whereParams: [],
        orderBySql: "",
        limitNum: null,
        offsetNum: null,
        joinsSql: ' LEFT JOIN "companies" AS "t1" ON "t0"."companyId" = "t1"."id"',
      });
      expect(result.sql).toContain("LEFT JOIN");
      expect(result.sql).toContain('"companies"');
    });

    it("compileSelectList uses relation alias for relation paths", () => {
      const select = {
        param: "c",
        paths: [["id"], ["company", "name"]] as string[][],
        aliases: ["id", "company_name"],
      };
      const result = sqliteDialect.compileSelectList(select, ["id", "name", "companyId"], {
        relationPathToAlias: { "c.company": "t1" },
      });
      expect(result).toContain('"t1"."name"');
      expect(result).toContain("company_name");
    });

    it("compileInsertMany produces multi-row INSERT without RETURNING", () => {
      const { sql, params, returningRow } = sqliteDialect.compileInsertMany(
        "users",
        ["name", "age"],
        [["Alice", 30], ["Bob", 25]],
        "id"
      );
      expect(sql).toContain('INSERT INTO "users"');
      expect(sql).toContain('"name"');
      expect(sql).toContain('"age"');
      expect(sql).toContain("VALUES");
      expect(sql).not.toContain("RETURNING");
      expect(params).toEqual(["Alice", 30, "Bob", 25]);
      expect(returningRow).toBe(false);
    });

    it("compileInsertMany with empty rows returns empty sql", () => {
      const { sql } = sqliteDialect.compileInsertMany("users", ["name"], [], "id");
      expect(sql).toBe("");
    });

    it("compileInsertMany maps SQL_DEFAULT to null for SQLite", () => {
      const { sql, params } = sqliteDialect.compileInsertMany(
        "users",
        ["name", "age"],
        [["Alice", SQL_DEFAULT], [SQL_DEFAULT, 25]],
        "id"
      );
      expect(sql).toContain("VALUES");
      expect(sql).not.toContain("DEFAULT");
      expect(params).toEqual(["Alice", null, null, 25]);
    });

    it("expandPlaceholders expands IN arrays to multiple ?", () => {
      const sql = '("t0"."id" IN (?))';
      const resolved = [[10, 20]];
      const { sql: outSql, params } = sqliteDialect.expandPlaceholders(sql, resolved);
      expect(outSql).toBe('("t0"."id" IN (?, ?))');
      expect(params).toEqual([10, 20]);
    });
  });

  describe("sqliteMigrations", () => {
    it("getDbTables returns table names", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      try {
        await driver.execute('CREATE TABLE "foo" ("id" integer primary key)');
        const tables = await sqliteMigrations.getDbTables(driver);
        expect(tables).toContain("foo");
      } finally {
        await driver.close();
      }
    });

    it("getDbColumns returns column info", async () => {
      const driver = createSqliteDriver({ path: ":memory:" });
      try {
        await driver.execute(
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
