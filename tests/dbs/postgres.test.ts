import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Expr } from "../../src/orm/expr.js";
import {
  createPostgresDriver,
  postgresMigrator,
  postgresQueryCompiler,
  getDialect,
} from "../../src/dbs/index.js";
import { Entity } from "../../src/entity/entity.js";
import { Db } from "../../src/orm/db.js";
import { clearRegistry, setDefaultDb } from "../../src/entity/global-driver.js";
import { SQL_DEFAULT } from "../../src/dbs/types.js";
import type { Driver } from "../../src/driver/types.js";
import {
  countPlan,
  deletePlan,
  insertManyPlan,
  insertPlan,
  selectPlan,
  updatePlan,
} from "./compiler-plan-fixtures.js";

const connectionString =
  process.env.TYPHEX_POSTGRES_URL ?? "postgresql://localhost:5432/typhex_test";

/** Run PostgreSQL integration tests only when TYPHEX_POSTGRES_URL is set. */
function hasPostgres(): boolean {
  return !!process.env.TYPHEX_POSTGRES_URL;
}

describe("dbs/postgres", () => {
  beforeAll(() => {
    clearRegistry();
  });

  afterAll(() => {
    setDefaultDb(null);
  });

  describe("postgresQueryCompiler", () => {
    it("rejects sequence allocation compilation until configured", () => {
      expect(() => postgresQueryCompiler.compileNextSequenceValues("users", "id", 2)).toThrow(
        "Postgres sequence allocation is not configured for this dialect yet",
      );
    });

    it("compiles WHERE with $N placeholders", () => {
      const expr: Expr = {
        kind: "binary",
        op: "===",
        left: { kind: "column", alias: "t0", column: ["age"] },
        right: { kind: "const", value: 18 },
      };
      const result = postgresQueryCompiler.compileWhereExpr(expr);
      expect(result.sql).toContain("$1");
      expect(result.params).toEqual([18]);
    });
    it("compilePlan insertMany produces multi-row INSERT with RETURNING * and sequential $N placeholders", () => {
      const { sql, params, returningRow } = postgresQueryCompiler.compilePlan(
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
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
      expect(sql).toContain("$3");
      expect(sql).toContain("$4");
      expect(params).toEqual(["Alice", 30, "Bob", 25]);
      expect(returningRow).toBe(true);
    });

    it("compilePlan insertMany with empty rows returns empty sql", () => {
      const { sql } = postgresQueryCompiler.compilePlan(
        insertManyPlan("users", ["name"], [], ["id"]),
      );
      expect(sql).toBe("");
    });

    it("compilePlan insertMany emits DEFAULT keyword for SQL_DEFAULT and skips its param slot", () => {
      const { sql, params } = postgresQueryCompiler.compilePlan(
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
      expect(sql).toContain("DEFAULT");
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
      // Only non-DEFAULT values become params
      expect(params).toEqual(["Alice", 25]);
    });

    it("compilePlan insert produces single-row INSERT with RETURNING *", () => {
      const { sql, params, returningRow } = postgresQueryCompiler.compilePlan(
        insertPlan("users", ["name", "age"], ["Alice", 30], ["id"]),
      );
      expect(sql).toBe('INSERT INTO "users" ("name", "age") VALUES ($1, $2) RETURNING *');
      expect(params).toEqual(["Alice", 30]);
      expect(returningRow).toBe(true);
    });

    it("compilePlan insert with no columns emits DEFAULT VALUES with RETURNING *", () => {
      const { sql, returningRow } = postgresQueryCompiler.compilePlan(
        insertPlan("users", [], [], ["id"]),
      );
      expect(sql).toBe('INSERT INTO "users" DEFAULT VALUES RETURNING *');
      expect(returningRow).toBe(true);
    });

    it("compilePlan insert with no pk omits RETURNING", () => {
      const { sql, returningRow } = postgresQueryCompiler.compilePlan(
        insertPlan("users", ["name"], ["Alice"]),
      );
      expect(sql).not.toContain("RETURNING");
      expect(returningRow).toBe(false);
    });

    it("compilePlan insert doNothing emits ON CONFLICT ... DO NOTHING before RETURNING", () => {
      const { sql } = postgresQueryCompiler.compilePlan(
        insertPlan("users", ["name", "slug"], ["Alice", "alice"], ["id"], {
          conflictColumns: ["slug"],
          action: "nothing",
        }),
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
      expect(sql).toContain("RETURNING *");
      expect(sql.indexOf("DO NOTHING")).toBeLessThan(sql.indexOf("RETURNING"));
    });

    it("compilePlan insert doUpdate uses EXCLUDED (uppercase for Postgres)", () => {
      const { sql } = postgresQueryCompiler.compilePlan(
        insertPlan("users", ["name", "slug"], ["Alice", "alice"], ["id"], {
          conflictColumns: ["slug"],
          action: "update",
        }),
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE SET "name" = EXCLUDED."name"');
      expect(sql).not.toContain('excluded."name"'); // SQLite uses lowercase; Postgres uses EXCLUDED
      expect(sql).toContain("RETURNING *");
    });

    it("compilePlan insert doUpdate with explicit updateColumns", () => {
      const { sql } = postgresQueryCompiler.compilePlan(
        insertPlan("products", ["sku", "name", "price"], ["X1", "Widget", 10], ["id"], {
          conflictColumns: ["sku"],
          action: "update",
          updateColumns: ["price"],
        }),
      );
      expect(sql).toContain('ON CONFLICT ("sku") DO UPDATE SET "price" = EXCLUDED."price"');
      expect(sql).not.toContain('"name" = EXCLUDED."name"');
    });

    it("compilePlan insertMany doNothing emits ON CONFLICT ... DO NOTHING with RETURNING", () => {
      const { sql, returningRow } = postgresQueryCompiler.compilePlan(
        insertManyPlan(
          "tags",
          ["slug", "label"],
          [["ts", "TypeScript"]],
          ["id"],
          { conflictColumns: ["slug"], action: "nothing" },
        ),
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
      expect(sql).toContain("RETURNING *");
      expect(returningRow).toBe(true);
    });

    it("compilePlan insertMany doUpdate uses EXCLUDED (uppercase)", () => {
      const { sql } = postgresQueryCompiler.compilePlan(
        insertManyPlan(
          "tags",
          ["slug", "label"],
          [["ts", "TypeScript"]],
          ["id"],
          { conflictColumns: ["slug"], action: "update" },
        ),
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE SET "label" = EXCLUDED."label"');
    });

    it("compilePlan count produces SELECT COUNT", () => {
      const { sql, params } = postgresQueryCompiler.compilePlan(
        countPlan("users", {
          kind: "binary",
          op: "===",
          left: { kind: "column", alias: "t0", column: ["age"] },
          right: { kind: "const", value: 18 },
        }),
      );
      expect(sql).toContain("SELECT COUNT(*) AS c");
      expect(sql).toContain('FROM "users"');
      expect(params).toEqual([18]);
    });

    it("compilePlan count with WITH merges and renumbers placeholders", () => {
      const innerState = {
        tableName: "users",
        columnNames: ["id", "age"],
        qe: { dialect: { queryCompiler: postgresQueryCompiler } },
        pkColumns: ["id"],
        whereIr: {
          node: {
            kind: "binary",
            op: ">=",
            left: { kind: "member", param: "u", path: ["age"] },
            right: { kind: "const", value: 19 },
          },
          rootParam: "u",
          localParamNames: ["u"],
        },
        whereParams: {},
        subqueryParams: {},
        orderBy: [],
        havingIr: null,
        havingParams: {},
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      };
      const { sql, params } = postgresQueryCompiler.compilePlan({
        ...countPlan("filtered", {
          kind: "binary",
          op: "===",
          left: { kind: "column", alias: "t0", column: ["age"] },
          right: { kind: "const", value: 30 },
        }),
        fromSource: { kind: "cte", name: "filtered" },
        ctes: [{ name: "filtered", kind: "simple", inner: innerState }],
      });
      expect(sql.startsWith('WITH "filtered" AS (')).toBe(true);
      expect(sql).toContain("SELECT COUNT(*) AS c");
      expect(sql).toContain('FROM "filtered"');
      expect(params).toEqual([19, 30]);
    });

    it("compilePlan update produces UPDATE with renumbered placeholders", () => {
      const { sql, params } = postgresQueryCompiler.compilePlan(
        updatePlan(
          "users",
          ["id", "name"],
          { name: "Bob" },
          {
            kind: "binary",
            op: "===",
            left: { kind: "column", alias: "t0", column: ["id"] },
            right: { kind: "const", value: 1 },
          },
        ),
      );
      expect(sql).toContain('UPDATE "users"');
      expect(sql).toContain('"name" = $1');
      expect(sql).toContain('"users"."id" = $2');
      expect(params).toEqual(["Bob", 1]);
    });

    it("compilePlan delete produces DELETE", () => {
      const { sql, params } = postgresQueryCompiler.compilePlan(
        deletePlan("users", {
          kind: "binary",
          op: "===",
          left: { kind: "column", alias: "t0", column: ["id"] },
          right: { kind: "const", value: 1 },
        }),
      );
      expect(sql).toContain('DELETE FROM "users"');
      expect(params).toEqual([1]);
    });

    it("compilePlan select: HAVING params are numbered after WHERE params", () => {
      const { sql, params } = postgresQueryCompiler.compilePlan(
        selectPlan("orders", {
          columnNames: ["category", "status", "price"],
          selectItems: [
            { expr: { kind: "column", alias: "t0", column: ["category"] } },
            {
              expr: {
                kind: "aggregate",
                func: "COUNT",
                arg: null,
                alias: "total",
              },
            },
          ],
          where: {
            kind: "binary",
            op: "&&",
            left: {
              kind: "binary",
              op: "===",
              left: { kind: "column", alias: "t0", column: ["status"] },
              right: { kind: "param", name: "status" },
            },
            right: {
              kind: "binary",
              op: ">",
              left: { kind: "column", alias: "t0", column: ["price"] },
              right: { kind: "param", name: "minPrice" },
            },
          },
          whereParams: { status: "active", minPrice: 10 },
          groupBy: [{ kind: "column", alias: "t0", column: ["category"] }],
          having: {
            kind: "binary",
            op: ">",
            left: { kind: "aggregate", func: "COUNT", arg: null },
            right: { kind: "const", value: 5 },
          },
        }),
      );
      expect(sql).toContain("WHERE");
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("HAVING");
      expect(params).toEqual(["active", 10, 5]);
      expect((sql.match(/\$1/g) ?? []).length).toBe(1);
      expect((sql.match(/\$2/g) ?? []).length).toBe(1);
      expect((sql.match(/\$3/g) ?? []).length).toBe(1);
    });

    it("compilePlan select: HAVING + LIMIT/OFFSET placeholder sequence is contiguous", () => {
      const { sql, params } = postgresQueryCompiler.compilePlan(
        selectPlan("orders", {
          columnNames: ["category", "active"],
          selectItems: [
            { expr: { kind: "aggregate", func: "COUNT", arg: null, alias: "total" } },
          ],
          where: {
            kind: "binary",
            op: "===",
            left: { kind: "column", alias: "t0", column: ["active"] },
            right: { kind: "param", name: "active" },
          },
          whereParams: { active: true },
          groupBy: [{ kind: "column", alias: "t0", column: ["category"] }],
          having: {
            kind: "binary",
            op: ">",
            left: { kind: "aggregate", func: "COUNT", arg: null },
            right: { kind: "const", value: 3 },
          },
          limitNum: 10,
          offsetNum: 20,
        }),
      );
      expect(params).toEqual([true, 3, 10, 20]);
      expect(sql).toMatch(/HAVING.*\$2/);
      expect(sql).toMatch(/LIMIT \$3/);
      expect(sql).toMatch(/OFFSET \$4/);
    });

    it("compilePlan select produces SELECT with LIMIT/OFFSET", () => {
      const { sql, params } = postgresQueryCompiler.compilePlan(
        selectPlan("users", {
          columnNames: ["id", "name"],
          selectItems: [
            { expr: { kind: "column", alias: "t0", column: ["id"] } },
            { expr: { kind: "column", alias: "t0", column: ["name"] } },
          ],
          orderBy: [{ expr: { kind: "column", alias: "t0", column: ["name"] }, direction: "asc" }],
          limitNum: 10,
          offsetNum: 5,
        }),
      );
      expect(sql).toContain('SELECT "t0"."id", "t0"."name"');
      expect(sql).toContain('FROM "users"');
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT");
      expect(sql).toContain("OFFSET");
      expect(params).toEqual([10, 5]);
    });
  });

  describe("postgresMigrator", () => {
    function metadataDriver(): Driver {
      return {
        dialect: getDialect("postgres"),
        async execute(sql: string, params: unknown[] = []) {
          if (sql.includes("information_schema.tables")) {
            return { rows: [{ table_name: "pg_test_users" }], changes: 0 };
          }
          if (sql.includes("information_schema.columns")) {
            expect(params).toEqual(["pg_test_users"]);
            return {
              rows: [{ name: "id", type: "integer", notnull: 1, dflt_value: null, pk: 1 }],
              changes: 0,
            };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      } as unknown as Driver;
    }

    it("getDbTables returns Postgres table names", async () => {
      const tables = await postgresMigrator.getDbTables(metadataDriver());
      expect(tables).toEqual(["pg_test_users"]);
    });

    it("getDbColumns returns Postgres column info", async () => {
      const columns = await postgresMigrator.getDbColumns(metadataDriver(), "pg_test_users");
      expect(columns).toEqual([
        { name: "id", type: "integer", notnull: 1, dflt_value: null, pk: 1 },
      ]);
    });

    it("diffSchema uses Postgres metadata", async () => {
      const actions = await postgresMigrator.diffSchema(metadataDriver(), [
        {
          table: {
            _table: "pg_test_users",
            _schema: {
              id: "integer primary key",
              name: "text",
            },
          },
        },
      ]);

      expect(actions).toEqual([
        {
          kind: "add_column",
          table: "pg_test_users",
          column: "name",
          definition: "text",
        },
      ]);
    });

    it("generateSql produces valid DDL for add_table", () => {
      const action = {
        kind: "add_table" as const,
        table: "pg_test_users",
        schema: {
          id: "SERIAL PRIMARY KEY",
          name: "VARCHAR(255) NOT NULL",
        },
      };
      const sql = postgresQueryCompiler.compileMigrationUp(action);
      expect(sql).toContain("CREATE TABLE");
      expect(sql).toContain('"pg_test_users"');
      expect(sql).toContain("SERIAL");
    });

    it("generateSql produces Postgres ALTER COLUMN DDL", () => {
      const sql = postgresQueryCompiler.compileMigrationUp({
        kind: "alter_column",
        table: "pg_test_users",
        column: "age",
        oldDef: "text",
        newDef: "INTEGER",
        columnInfo: { name: "age", type: "text", notnull: 0, dflt_value: null, pk: 0 },
        changes: [{ kind: "type", from: "text", to: "integer" }],
      });
      expect(sql).toBe('ALTER TABLE "pg_test_users" ALTER COLUMN "age" TYPE integer;');
    });

    it("generateSql produces Postgres ALTER COLUMN DDL for constraints and defaults", () => {
      const sql = postgresQueryCompiler.compileMigrationUp({
        kind: "alter_column",
        table: "pg_test_users",
        column: "name",
        oldDef: "text",
        newDef: "text not null default 'Anon'",
        columnInfo: { name: "name", type: "text", notnull: 0, dflt_value: null, pk: 0 },
        changes: [
          { kind: "not_null", from: false, to: true },
          { kind: "default", from: null, to: "'Anon'" },
        ],
      });
      expect(sql).toBe(
        'ALTER TABLE "pg_test_users" ALTER COLUMN "name" SET NOT NULL;\n' +
          'ALTER TABLE "pg_test_users" ALTER COLUMN "name" SET DEFAULT \'Anon\';',
      );
    });

    it("generateSql throws on primary_key alter (no safe single-statement form)", () => {
      expect(() =>
        postgresQueryCompiler.compileMigrationUp({
          kind: "alter_column",
          table: "pg_test_users",
          column: "id",
          oldDef: "integer",
          newDef: "integer primary key",
          columnInfo: { name: "id", type: "integer", notnull: 1, dflt_value: null, pk: 0 },
          changes: [{ kind: "primary_key", from: false, to: true }],
        }),
      ).toThrow(/Primary key change on pg_test_users\.id/);
    });

    it("generateDownSql produces reverse Postgres DDL", () => {
      const addTable = postgresQueryCompiler.compileMigrationDown({
        kind: "add_table",
        table: "pg_test_users",
        schema: { id: "SERIAL PRIMARY KEY" },
      });
      expect(addTable).toContain('DROP TABLE IF EXISTS "pg_test_users"');

      const dropTable = postgresQueryCompiler.compileMigrationDown({
        kind: "drop_table",
        table: "pg_test_users",
        columnInfos: [
          { name: "id", type: "integer", notnull: 0, dflt_value: null, pk: 1 },
          { name: "name", type: "text", notnull: 1, dflt_value: "'anon'", pk: 0 },
        ],
      });
      expect(dropTable).toContain('CREATE TABLE IF NOT EXISTS "pg_test_users"');
      expect(dropTable).toContain('"id" integer PRIMARY KEY');
      expect(dropTable).toContain("\"name\" text NOT NULL DEFAULT 'anon'");

      const addColumn = postgresQueryCompiler.compileMigrationDown({
        kind: "add_column",
        table: "pg_test_users",
        column: "age",
        definition: "INTEGER",
      });
      expect(addColumn).toContain('DROP COLUMN "age"');

      const dropColumn = postgresQueryCompiler.compileMigrationDown({
        kind: "drop_column",
        table: "pg_test_users",
        column: "age",
        columnInfo: { name: "age", type: "integer", notnull: 0, dflt_value: null, pk: 0 },
      });
      expect(dropColumn).toContain('ADD COLUMN "age" integer');
    });

    it("generateDownSql restores old Postgres alter_column type", () => {
      const sql = postgresQueryCompiler.compileMigrationDown({
        kind: "alter_column",
        table: "pg_test_users",
        column: "age",
        oldDef: "text",
        newDef: "INTEGER",
        columnInfo: { name: "age", type: "text", notnull: 0, dflt_value: null, pk: 0 },
        changes: [{ kind: "type", from: "text", to: "integer" }],
      });
      expect(sql).toBe('ALTER TABLE "pg_test_users" ALTER COLUMN "age" TYPE text;');
    });

    it("generateDownSql reverses Postgres constraint and default changes", () => {
      const sql = postgresQueryCompiler.compileMigrationDown({
        kind: "alter_column",
        table: "pg_test_users",
        column: "name",
        oldDef: "text",
        newDef: "text not null default 'Anon'",
        columnInfo: { name: "name", type: "text", notnull: 0, dflt_value: null, pk: 0 },
        changes: [
          { kind: "not_null", from: false, to: true },
          { kind: "default", from: null, to: "'Anon'" },
        ],
      });
      expect(sql).toBe(
        'ALTER TABLE "pg_test_users" ALTER COLUMN "name" DROP NOT NULL;\n' +
          'ALTER TABLE "pg_test_users" ALTER COLUMN "name" DROP DEFAULT;',
      );
    });

    it("getTrackingTableDdl produces Postgres DDL", () => {
      const ddl = postgresQueryCompiler.compileTrackingTable().sql;
      expect(ddl).toContain("_typhex_migrations");
      expect(ddl).toContain("SERIAL");
      expect(ddl).toContain("DEFAULT NOW()");
    });

    it("getRecordMigrationSql uses $1 placeholder", () => {
      const sql = postgresQueryCompiler.compileRecordMigration("migration_name").sql;
      expect(sql).toContain("INSERT INTO");
      expect(sql).toContain("$1");
    });

    it("getDeleteMigrationSql uses $1 placeholder", () => {
      const sql = postgresQueryCompiler.compileDeleteMigration("migration_name").sql;
      expect(sql).toContain("DELETE FROM");
      expect(sql).toContain("$1");
    });
  });

  describe("getDialect", () => {
    it("returns postgres dialect for postgres", () => {
      const d = getDialect("postgres");
      expect(d.name).toBe("postgres");
    });
  });

  describe("createPostgresDriver (integration)", () => {
    it(
      "connects and runs queries",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString });
        try {
          const result = await driver.execute("SELECT 1 as x", []);
          expect(result.rows).toHaveLength(1);
          expect((result.rows[0] as { x: number }).x).toBe(1);
        } finally {
          await driver.close();
        }
      },
      { skip: !hasPostgres() },
    );

    it(
      "supports concurrent queries via connection pooling",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString, poolMin: 2, poolMax: 5 });
        try {
          // Fire multiple concurrent queries to exercise the pool
          const results = await Promise.all([
            driver.execute("SELECT 1 as n", []),
            driver.execute("SELECT 2 as n", []),
            driver.execute("SELECT 3 as n", []),
            driver.execute("SELECT 4 as n", []),
            driver.execute("SELECT 5 as n", []),
          ]);
          expect(results).toHaveLength(5);
          results.forEach((result, i) => {
            expect(result.rows).toHaveLength(1);
            expect((result.rows[0] as { n: number }).n).toBe(i + 1);
          });
        } finally {
          await driver.close();
        }
      },
      { skip: !hasPostgres() },
    );

    it(
      "rolls back transaction on error",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString });
        const db = new Db(driver);
        try {
          await driver.execute("DROP TABLE IF EXISTS pg_tx_rollback_test", []);
          await driver.execute(
            "CREATE TABLE pg_tx_rollback_test (id SERIAL PRIMARY KEY, val TEXT)",
            [],
          );

          await expect(
            db.transaction(async (trx) => {
              await trx.run("INSERT INTO pg_tx_rollback_test (val) VALUES ($1)", [
                "should-rollback",
              ]);
              throw new Error("intentional rollback");
            }),
          ).rejects.toThrow("intentional rollback");

          const result = await driver.execute("SELECT * FROM pg_tx_rollback_test", []);
          expect(result.rows).toHaveLength(0);
        } finally {
          await driver.execute("DROP TABLE IF EXISTS pg_tx_rollback_test", []);
          await db.close();
        }
      },
      { skip: !hasPostgres() },
    );

    it(
      "wraps errors with SQL context",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString });
        try {
          await expect(
            driver.execute("SELECT * FROM nonexistent_table_xyz_typhex", []),
          ).rejects.toThrow(/PG\([\s\S]*SQL:\s*SELECT \* FROM nonexistent_table_xyz_typhex/);
        } finally {
          await driver.close();
        }
      },
      { skip: !hasPostgres() },
    );

    it(
      "closes pool cleanly",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString });
        // Run a query to ensure pool is active
        await driver.execute("SELECT 1", []);
        // close() should resolve without error
        await expect(driver.close()).resolves.toBeUndefined();
      },
      { skip: !hasPostgres() },
    );

    it(
      "Entity CRUD with PostgreSQL",
      async () => {
        clearRegistry();
        const User = Entity("pg_test_users", {
          id: "SERIAL PRIMARY KEY",
          name: "VARCHAR(255) NOT NULL",
          age: "INTEGER NOT NULL",
        });

        const driver = createPostgresDriver({ connectionString });
        const db = new Db(driver); // automatically sets default Db

        try {
          await driver.execute('DROP TABLE IF EXISTS "pg_test_users"', []);
          await db.migrate();

          const u = await User.query().insert({ name: "Alice", age: 30 });
          expect(u.id).toBe(1);

          const found = await User.query()
            .where((u) => u.name === "Alice")
            .first();
          expect(found?.name).toBe("Alice");

          const count = await User.query().count();
          expect(count).toBe(1);
        } finally {
          await db.close();
        }
      },
      { skip: !hasPostgres() },
    );
  });
});
