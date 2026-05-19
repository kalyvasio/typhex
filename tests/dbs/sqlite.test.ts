import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSqliteDriver,
  sqliteMigrations as sqliteMigrationsImpl,
  sqliteQueryCompiler,
  getDialect,
} from "../../src/dbs/index.js";
import { clearRegistry, setDefaultDb } from "../../src/entity/global-driver.js";
import { Db } from "../../src/orm/db.js";
import { SQL_DEFAULT } from "../../src/dbs/types.js";
import type { Expr, SelectItem } from "../../src/orm/expr.js";

const sqliteDialect = sqliteQueryCompiler as any;
const sqliteMigrations = {
  ...sqliteMigrationsImpl,
  diffSchema: sqliteMigrationsImpl.diffSchema.bind(sqliteMigrationsImpl),
  getDbTables: sqliteMigrationsImpl.getDbTables.bind(sqliteMigrationsImpl),
  getDbColumns: sqliteMigrationsImpl.getDbColumns.bind(sqliteMigrationsImpl),
  generateSql: sqliteQueryCompiler.compileMigrationUp.bind(sqliteQueryCompiler),
  generateDownSql: sqliteQueryCompiler.compileMigrationDown.bind(sqliteQueryCompiler),
  getTrackingTableDdl: () => sqliteQueryCompiler.compileTrackingTable().sql,
  getRecordMigrationSql: () => sqliteQueryCompiler.compileRecordMigration("").sql,
  getDeleteMigrationSql: () => sqliteQueryCompiler.compileDeleteMigration("").sql,
};

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
        const rows = await driver.execute("SELECT 1 as x").then((r) => r.rows);
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
        const rows = await driver.execute('SELECT * FROM "t"').then((r) => r.rows);
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
          }),
        ).rejects.toThrow("abort");
        const rows = await driver.execute('SELECT * FROM "t"').then((r) => r.rows);
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

    it("rejects sequence allocation compilation", () => {
      expect(() => sqliteDialect.compileNextSequenceValues("users", "id", 2)).toThrow(
        "SQLite does not support sequence allocation",
      );
    });

    it("escapes identifiers", () => {
      expect(sqliteDialect.escapeIdentifier("users")).toBe('"users"');
      expect(sqliteDialect.escapeIdentifier('a"b')).toBe('"a""b"');
    });

    it("compiles WHERE with ? placeholders", () => {
      const expr: Expr = {
        kind: "binary",
        op: "===",
        left: { kind: "column", alias: "t0", column: ["age"] },
        right: { kind: "const", value: 18 },
      };
      const result = sqliteQueryCompiler.compileWhereExpr(expr);
      expect(result.sql).toContain("?");
      expect(result.params).toEqual([18]);
    });

    it("compiles WHERE with relation alias on column", () => {
      // Relation paths are alias-resolved by the planner; here we render the
      // resolved ExprColumn directly.
      const expr: Expr = {
        kind: "binary",
        op: "===",
        left: { kind: "column", alias: "t1", column: ["name"] },
        right: { kind: "const", value: "Acme" },
      };
      const result = sqliteQueryCompiler.compileWhereExpr(expr);
      expect(result.sql).toContain('"t1"."name"');
      expect(result.params).toEqual(["Acme"]);
    });

    it("compileSelect emits LEFT JOIN for relation joins", () => {
      const result = sqliteDialect.compileSelect({
        table: "contacts",
        tableAlias: "t0",
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

    it("compileSelectList renders relation-aliased columns", () => {
      const items: SelectItem[] = [
        { expr: { kind: "column", alias: "t0", column: ["id"] }, alias: "id" },
        { expr: { kind: "column", alias: "t1", column: ["name"] }, alias: "company_name" },
      ];
      const result = sqliteQueryCompiler.compileSelectListExpr(
        items,
        false,
        "t0",
        ["id", "name", "companyId"],
      );
      expect(result.sql).toContain('"t1"."name"');
      expect(result.sql).toContain("company_name");
    });

    it("compileInsertMany produces multi-row INSERT with RETURNING * when pk provided", () => {
      const { sql, params, returningRow } = sqliteDialect.compileInsertMany(
        "users",
        ["name", "age"],
        [
          ["Alice", 30],
          ["Bob", 25],
        ],
        "id",
      );
      expect(sql).toContain('INSERT INTO "users"');
      expect(sql).toContain('"name"');
      expect(sql).toContain('"age"');
      expect(sql).toContain("VALUES");
      expect(sql).toContain("RETURNING *");
      expect(params).toEqual(["Alice", 30, "Bob", 25]);
      expect(returningRow).toBe(true);
    });

    it("compileInsertMany without pk omits RETURNING", () => {
      const { sql, returningRow } = sqliteDialect.compileInsertMany(
        "users",
        ["name", "age"],
        [["Alice", 30]],
      );
      expect(sql).not.toContain("RETURNING");
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
        [
          ["Alice", SQL_DEFAULT],
          [SQL_DEFAULT, 25],
        ],
        "id",
      );
      expect(sql).toContain("VALUES");
      expect(sql).not.toContain("DEFAULT");
      expect(params).toEqual(["Alice", null, null, 25]);
    });

    it("compileInsert produces single-row INSERT without RETURNING (SQLite ignores pk)", () => {
      const { sql, params, returningRow } = sqliteDialect.compileInsert(
        "users",
        ["name", "age"],
        ["Alice", 30],
        "id",
      );
      expect(sql).toBe('INSERT INTO "users" ("name", "age") VALUES (?, ?)');
      expect(params).toEqual(["Alice", 30]);
      expect(returningRow).toBe(false);
    });

    it("compileInsert with no columns emits DEFAULT VALUES", () => {
      const { sql, params } = sqliteDialect.compileInsert("users", [], []);
      expect(sql).toBe('INSERT INTO "users" DEFAULT VALUES');
      expect(params).toEqual([]);
    });

    it("compileInsert doNothing emits ON CONFLICT ... DO NOTHING", () => {
      const { sql } = sqliteDialect.compileInsert(
        "users",
        ["name", "slug"],
        ["Alice", "alice"],
        undefined,
        { conflictColumns: ["slug"], action: "nothing" },
      );
      expect(sql).toBe(
        'INSERT INTO "users" ("name", "slug") VALUES (?, ?) ON CONFLICT ("slug") DO NOTHING',
      );
    });

    it("compileInsert doUpdate infers update columns (excludes conflict columns)", () => {
      const { sql } = sqliteDialect.compileInsert(
        "users",
        ["name", "slug"],
        ["Alice", "alice"],
        undefined,
        { conflictColumns: ["slug"], action: "update" },
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE SET');
      expect(sql).toContain('"name" = excluded."name"');
      expect(sql).not.toContain('"slug" = excluded."slug"');
    });

    it("compileInsert doUpdate with explicit updateColumns", () => {
      const { sql } = sqliteDialect.compileInsert(
        "products",
        ["sku", "name", "price"],
        ["X1", "Widget", 10],
        undefined,
        { conflictColumns: ["sku"], action: "update", updateColumns: ["price"] },
      );
      expect(sql).toContain('ON CONFLICT ("sku") DO UPDATE SET "price" = excluded."price"');
      expect(sql).not.toContain('"name" = excluded."name"');
    });

    it("compileInsertMany doNothing emits ON CONFLICT ... DO NOTHING", () => {
      const { sql } = sqliteDialect.compileInsertMany(
        "tags",
        ["slug", "label"],
        [
          ["ts", "TypeScript"],
          ["js", "JavaScript"],
        ],
        undefined,
        { conflictColumns: ["slug"], action: "nothing" },
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
      expect(sql).not.toContain("RETURNING");
    });

    it("compileInsertMany doUpdate emits ON CONFLICT ... DO UPDATE SET", () => {
      const { sql } = sqliteDialect.compileInsertMany(
        "tags",
        ["slug", "label"],
        [["ts", "TypeScript"]],
        undefined,
        { conflictColumns: ["slug"], action: "update" },
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE SET "label" = excluded."label"');
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
          'CREATE TABLE "users" ("id" integer primary key, "name" text not null)',
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

    it("generateSql throws on alter_column (SQLite has no native ALTER COLUMN)", () => {
      const action = {
        kind: "alter_column" as const,
        table: "users",
        column: "age",
        oldDef: "TEXT",
        newDef: "integer",
        columnInfo: { name: "age", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        changes: [{ kind: "type" as const, from: "text", to: "integer" }],
      };
      expect(() => sqliteMigrations.generateSql(action)).toThrow(
        /SQLite cannot apply ALTER COLUMN on users\.age/,
      );
    });

    it("generateDownSql produces reverse SQLite DDL", () => {
      const addTable = sqliteMigrations.generateDownSql({
        kind: "add_table",
        table: "users",
        schema: { id: "integer primary key" },
      });
      expect(addTable).toContain('DROP TABLE IF EXISTS "users"');

      const dropTable = sqliteMigrations.generateDownSql({
        kind: "drop_table",
        table: "users",
        columnInfos: [
          { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
          { name: "name", type: "TEXT", notnull: 1, dflt_value: "'anon'", pk: 0 },
        ],
      });
      expect(dropTable).toContain('CREATE TABLE IF NOT EXISTS "users"');
      expect(dropTable).toContain('"id" INTEGER PRIMARY KEY');
      expect(dropTable).toContain("\"name\" TEXT NOT NULL DEFAULT 'anon'");

      const addColumn = sqliteMigrations.generateDownSql({
        kind: "add_column",
        table: "users",
        column: "age",
        definition: "integer",
      });
      expect(addColumn).toContain('DROP COLUMN "age"');

      const dropColumn = sqliteMigrations.generateDownSql({
        kind: "drop_column",
        table: "users",
        column: "age",
        columnInfo: { name: "age", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      });
      expect(dropColumn).toContain('ADD COLUMN "age" INTEGER');
    });

    it("generateDownSql throws on alter_column rollback", () => {
      const action = {
        kind: "alter_column" as const,
        table: "users",
        column: "age",
        oldDef: "TEXT",
        newDef: "integer",
        columnInfo: { name: "age", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        changes: [{ kind: "type" as const, from: "text", to: "integer" }],
      };
      expect(() => sqliteMigrations.generateDownSql(action)).toThrow(
        /SQLite cannot rollback ALTER COLUMN on users\.age/,
      );
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

    it("getDeleteMigrationSql uses ? placeholder", () => {
      const sql = sqliteMigrations.getDeleteMigrationSql();
      expect(sql).toContain("DELETE FROM");
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
