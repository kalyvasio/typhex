import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSqliteDriver,
  sqliteMigrations,
  sqliteQueryCompiler,
  getDialect,
} from "../../src/dbs/index.js";
import { clearRegistry, setDefaultDb } from "../../src/entity/global-driver.js";
import { Db } from "../../src/orm/db.js";
import { SQL_DEFAULT } from "../../src/dbs/types.js";
import type { Expr, SelectItem } from "../../src/orm/expr.js";
import {
  insertManyPlan,
  insertPlan,
  selectPlan,
} from "./compiler-plan-fixtures.js";

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

  describe("sqliteQueryCompiler", () => {
    it("rejects sequence allocation compilation", () => {
      expect(() => sqliteQueryCompiler.compileNextSequenceValues("users", "id", 2)).toThrow(
        "SQLite does not support sequence allocation",
      );
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

    it("compilePlan select emits LEFT JOIN for relation joins", () => {
      const result = sqliteQueryCompiler.compilePlan(
        selectPlan("contacts", {
          columnNames: ["id", "companyId"],
          selectItems: [
            { expr: { kind: "column", alias: "t0", column: ["id"] }, alias: "id" },
            { expr: { kind: "column", alias: "t1", column: ["name"] }, alias: "company_name" },
          ],
          joins: [
            {
              joinType: "left",
              targetTable: "companies",
              alias: "t1",
              foreignKeys: ["companyId"],
              targetPkColumns: ["id"],
            },
          ],
        }),
      );
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

    it("compilePlan insertMany produces multi-row INSERT with RETURNING * when pk provided", () => {
      const { sql, params, returningRow } = sqliteQueryCompiler.compilePlan(
        insertManyPlan(
          "users",
          ["name", "age"],
          [
            ["Alice", 30],
            ["Bob", 25],
          ],
          ["id"],
        ),
      );
      expect(sql).toContain('INSERT INTO "users"');
      expect(sql).toContain('"name"');
      expect(sql).toContain('"age"');
      expect(sql).toContain("VALUES");
      expect(sql).toContain("RETURNING *");
      expect(params).toEqual(["Alice", 30, "Bob", 25]);
      expect(returningRow).toBe(true);
    });

    it("compilePlan insertMany without pk omits RETURNING", () => {
      const { sql, returningRow } = sqliteQueryCompiler.compilePlan(
        insertManyPlan("users", ["name", "age"], [["Alice", 30]]),
      );
      expect(sql).not.toContain("RETURNING");
      expect(returningRow).toBe(false);
    });

    it("compilePlan insertMany with empty rows returns empty sql", () => {
      const { sql } = sqliteQueryCompiler.compilePlan(
        insertManyPlan("users", ["name"], [], ["id"]),
      );
      expect(sql).toBe("");
    });

    it("compilePlan insertMany maps SQL_DEFAULT to null for SQLite", () => {
      const { sql, params } = sqliteQueryCompiler.compilePlan(
        insertManyPlan(
          "users",
          ["name", "age"],
          [
            ["Alice", SQL_DEFAULT],
            [SQL_DEFAULT, 25],
          ],
          ["id"],
        ),
      );
      expect(sql).toContain("VALUES");
      expect(sql).not.toContain("DEFAULT");
      expect(params).toEqual(["Alice", null, null, 25]);
    });

    it("compilePlan insert produces single-row INSERT without RETURNING (SQLite ignores pk)", () => {
      const { sql, params, returningRow } = sqliteQueryCompiler.compilePlan(
        insertPlan("users", ["name", "age"], ["Alice", 30], ["id"]),
      );
      expect(sql).toBe('INSERT INTO "users" ("name", "age") VALUES (?, ?)');
      expect(params).toEqual(["Alice", 30]);
      expect(returningRow).toBe(false);
    });

    it("compilePlan insert with no columns emits DEFAULT VALUES", () => {
      const { sql, params } = sqliteQueryCompiler.compilePlan(insertPlan("users", [], []));
      expect(sql).toBe('INSERT INTO "users" DEFAULT VALUES');
      expect(params).toEqual([]);
    });

    it("compilePlan insert doNothing emits ON CONFLICT ... DO NOTHING", () => {
      const { sql } = sqliteQueryCompiler.compilePlan(
        insertPlan("users", ["name", "slug"], ["Alice", "alice"], undefined, {
          conflictColumns: ["slug"],
          action: "nothing",
        }),
      );
      expect(sql).toBe(
        'INSERT INTO "users" ("name", "slug") VALUES (?, ?) ON CONFLICT ("slug") DO NOTHING',
      );
    });

    it("compilePlan insert doUpdate infers update columns (excludes conflict columns)", () => {
      const { sql } = sqliteQueryCompiler.compilePlan(
        insertPlan("users", ["name", "slug"], ["Alice", "alice"], undefined, {
          conflictColumns: ["slug"],
          action: "update",
        }),
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE SET');
      expect(sql).toContain('"name" = excluded."name"');
      expect(sql).not.toContain('"slug" = excluded."slug"');
    });

    it("compilePlan insert doUpdate with explicit updateColumns", () => {
      const { sql } = sqliteQueryCompiler.compilePlan(
        insertPlan("products", ["sku", "name", "price"], ["X1", "Widget", 10], undefined, {
          conflictColumns: ["sku"],
          action: "update",
          updateColumns: ["price"],
        }),
      );
      expect(sql).toContain('ON CONFLICT ("sku") DO UPDATE SET "price" = excluded."price"');
      expect(sql).not.toContain('"name" = excluded."name"');
    });

    it("compilePlan insertMany doNothing emits ON CONFLICT ... DO NOTHING", () => {
      const { sql } = sqliteQueryCompiler.compilePlan(
        insertManyPlan(
          "tags",
          ["slug", "label"],
          [
            ["ts", "TypeScript"],
            ["js", "JavaScript"],
          ],
          undefined,
          { conflictColumns: ["slug"], action: "nothing" },
        ),
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
      expect(sql).not.toContain("RETURNING");
    });

    it("compilePlan insertMany doUpdate emits ON CONFLICT ... DO UPDATE SET", () => {
      const { sql } = sqliteQueryCompiler.compilePlan(
        insertManyPlan(
          "tags",
          ["slug", "label"],
          [["ts", "TypeScript"]],
          undefined,
          { conflictColumns: ["slug"], action: "update" },
        ),
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE SET "label" = excluded."label"');
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
      const sql = sqliteQueryCompiler.compileMigrationUp(action);
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
      expect(() => sqliteQueryCompiler.compileMigrationUp(action)).toThrow(
        /SQLite cannot apply ALTER COLUMN on users\.age/,
      );
    });

    it("generateDownSql produces reverse SQLite DDL", () => {
      const addTable = sqliteQueryCompiler.compileMigrationDown({
        kind: "add_table",
        table: "users",
        schema: { id: "integer primary key" },
      });
      expect(addTable).toContain('DROP TABLE IF EXISTS "users"');

      const dropTable = sqliteQueryCompiler.compileMigrationDown({
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

      const addColumn = sqliteQueryCompiler.compileMigrationDown({
        kind: "add_column",
        table: "users",
        column: "age",
        definition: "integer",
      });
      expect(addColumn).toContain('DROP COLUMN "age"');

      const dropColumn = sqliteQueryCompiler.compileMigrationDown({
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
      expect(() => sqliteQueryCompiler.compileMigrationDown(action)).toThrow(
        /SQLite cannot rollback ALTER COLUMN on users\.age/,
      );
    });

    it("getTrackingTableDdl produces SQLite DDL", () => {
      const ddl = sqliteQueryCompiler.compileTrackingTable().sql;
      expect(ddl).toContain("_typhex_migrations");
      expect(ddl).toContain("autoincrement");
      expect(ddl).toContain("datetime('now')");
    });

    it("getRecordMigrationSql uses ? placeholder", () => {
      const sql = sqliteQueryCompiler.compileRecordMigration("migration_name").sql;
      expect(sql).toContain("INSERT INTO");
      expect(sql).toContain("?");
    });

    it("getDeleteMigrationSql uses ? placeholder", () => {
      const sql = sqliteQueryCompiler.compileDeleteMigration("migration_name").sql;
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
