import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPostgresDriver,
  postgresDialect,
  postgresMigrations,
  getDialect,
} from "../../src/dbs/index.js";
import { Entity } from "../../src/entity/entity.js";
import { Db } from "../../src/orm/db.js";
import { clearRegistry, setDefaultDb } from "../../src/entity/global-driver.js";
import { SQL_DEFAULT } from "../../src/dbs/types.js";

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

  describe("postgresDialect", () => {
    it("uses $1, $2 placeholders", () => {
      expect(postgresDialect.placeholder(1)).toBe("$1");
      expect(postgresDialect.placeholder(2)).toBe("$2");
    });

    it("rejects sequence allocation compilation until configured", () => {
      expect(() => postgresDialect.compileNextSequenceValues("users", "id", 2)).toThrow(
        "Postgres sequence allocation is not configured for this dialect yet",
      );
    });

    it("escapes identifiers", () => {
      expect(postgresDialect.escapeIdentifier("users")).toBe('"users"');
    });

    it("compiles WHERE with $N placeholders", () => {
      const ir = {
        kind: "binary" as const,
        op: "===" as const,
        left: { kind: "member" as const, param: "u", path: ["age"] },
        right: { kind: "const" as const, value: 18 },
      };
      const result = postgresDialect.compileWhere(ir, {});
      expect(result.sql).toContain("$1");
      expect(result.params).toEqual([18]);
    });
    it("compileInsertMany produces multi-row INSERT with RETURNING * and sequential $N placeholders", () => {
      const { sql, params, returningRow } = postgresDialect.compileInsertMany(
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
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
      expect(sql).toContain("$3");
      expect(sql).toContain("$4");
      expect(params).toEqual(["Alice", 30, "Bob", 25]);
      expect(returningRow).toBe(true);
    });

    it("compileInsertMany with empty rows returns empty sql", () => {
      const { sql } = postgresDialect.compileInsertMany("users", ["name"], [], "id");
      expect(sql).toBe("");
    });

    it("compileInsertMany emits DEFAULT keyword for SQL_DEFAULT and skips its param slot", () => {
      const { sql, params } = postgresDialect.compileInsertMany(
        "users",
        ["name", "age"],
        [
          ["Alice", SQL_DEFAULT],
          [SQL_DEFAULT, 25],
        ],
        "id",
      );
      expect(sql).toContain("DEFAULT");
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
      // Only non-DEFAULT values become params
      expect(params).toEqual(["Alice", 25]);
    });

    it("compileInsert produces single-row INSERT with RETURNING *", () => {
      const { sql, params, returningRow } = postgresDialect.compileInsert(
        "users",
        ["name", "age"],
        ["Alice", 30],
        "id",
      );
      expect(sql).toBe('INSERT INTO "users" ("name", "age") VALUES ($1, $2) RETURNING *');
      expect(params).toEqual(["Alice", 30]);
      expect(returningRow).toBe(true);
    });

    it("compileInsert with no columns emits DEFAULT VALUES with RETURNING *", () => {
      const { sql, returningRow } = postgresDialect.compileInsert("users", [], [], "id");
      expect(sql).toBe('INSERT INTO "users" DEFAULT VALUES RETURNING *');
      expect(returningRow).toBe(true);
    });

    it("compileInsert with no pk omits RETURNING", () => {
      const { sql, returningRow } = postgresDialect.compileInsert("users", ["name"], ["Alice"]);
      expect(sql).not.toContain("RETURNING");
      expect(returningRow).toBe(false);
    });

    it("compileInsert doNothing emits ON CONFLICT ... DO NOTHING before RETURNING", () => {
      const { sql } = postgresDialect.compileInsert(
        "users",
        ["name", "slug"],
        ["Alice", "alice"],
        "id",
        { conflictColumns: ["slug"], action: "nothing" },
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
      expect(sql).toContain("RETURNING *");
      expect(sql.indexOf("DO NOTHING")).toBeLessThan(sql.indexOf("RETURNING"));
    });

    it("compileInsert doUpdate uses EXCLUDED (uppercase for Postgres)", () => {
      const { sql } = postgresDialect.compileInsert(
        "users",
        ["name", "slug"],
        ["Alice", "alice"],
        "id",
        { conflictColumns: ["slug"], action: "update" },
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE SET "name" = EXCLUDED."name"');
      expect(sql).not.toContain('excluded."name"'); // SQLite uses lowercase; Postgres uses EXCLUDED
      expect(sql).toContain("RETURNING *");
    });

    it("compileInsert doUpdate with explicit updateColumns", () => {
      const { sql } = postgresDialect.compileInsert(
        "products",
        ["sku", "name", "price"],
        ["X1", "Widget", 10],
        "id",
        { conflictColumns: ["sku"], action: "update", updateColumns: ["price"] },
      );
      expect(sql).toContain('ON CONFLICT ("sku") DO UPDATE SET "price" = EXCLUDED."price"');
      expect(sql).not.toContain('"name" = EXCLUDED."name"');
    });

    it("compileInsertMany doNothing emits ON CONFLICT ... DO NOTHING with RETURNING", () => {
      const { sql, returningRow } = postgresDialect.compileInsertMany(
        "tags",
        ["slug", "label"],
        [["ts", "TypeScript"]],
        "id",
        { conflictColumns: ["slug"], action: "nothing" },
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO NOTHING');
      expect(sql).toContain("RETURNING *");
      expect(returningRow).toBe(true);
    });

    it("compileInsertMany doUpdate uses EXCLUDED (uppercase)", () => {
      const { sql } = postgresDialect.compileInsertMany(
        "tags",
        ["slug", "label"],
        [["ts", "TypeScript"]],
        "id",
        { conflictColumns: ["slug"], action: "update" },
      );
      expect(sql).toContain('ON CONFLICT ("slug") DO UPDATE SET "label" = EXCLUDED."label"');
    });

    it("compileCount produces SELECT COUNT", () => {
      const { sql, params } = postgresDialect.compileCount("users", '"t0"."age" = $1', [18]);
      expect(sql).toContain("SELECT COUNT(*) AS c");
      expect(sql).toContain('FROM "users"');
      expect(params).toEqual([18]);
    });

    it("compileUpdate produces UPDATE with renumbered placeholders", () => {
      const { sql, params } = postgresDialect.compileUpdate(
        "users",
        { name: "Bob" },
        ["id", "name"],
        '"t0"."id" = $1',
        [1],
      );
      expect(sql).toContain('UPDATE "users"');
      expect(sql).toContain('"name" = $1');
      expect(sql).toContain('"users"."id" = $2');
      expect(params).toEqual(["Bob", 1]);
    });

    it("compileDelete produces DELETE", () => {
      const { sql, params } = postgresDialect.compileDelete("users", '"t0"."id" = $1', [1]);
      expect(sql).toContain('DELETE FROM "users"');
      expect(params).toEqual([1]);
    });

    it("expandPlaceholders expands IN arrays to $1, $2", () => {
      const sql = '("t0"."id" IN ($1))';
      const resolved = [[10, 20]];
      const { sql: outSql, params } = postgresDialect.expandPlaceholders(sql, resolved);
      expect(outSql).toBe('("t0"."id" IN ($1, $2))');
      expect(params).toEqual([10, 20]);
    });

    it("expandPlaceholders respects startIdx — numbers from the given offset", () => {
      const sql = '("t0"."age" > $1)';
      const { sql: outSql, params } = postgresDialect.expandPlaceholders(sql, [25], 3);
      expect(outSql).toBe('("t0"."age" > $3)');
      expect(params).toEqual([25]);
    });

    it("expandPlaceholders with startIdx expands IN arrays from the offset", () => {
      const sql = '("t0"."id" IN ($1))';
      const { sql: outSql, params } = postgresDialect.expandPlaceholders(sql, [[10, 20]], 5);
      expect(outSql).toBe('("t0"."id" IN ($5, $6))');
      expect(params).toEqual([10, 20]);
    });

    it("compileSelect: HAVING params are numbered after WHERE params", () => {
      // WHERE has 2 params ($1, $2); HAVING arrives pre-numbered from $3
      const { sql, params } = postgresDialect.compileSelect({
        table: "orders",
        selectList: '"t0"."category", COUNT(*) AS "total"',
        whereSql: '("t0"."status" = $1 AND "t0"."price" > $2)',
        whereParams: ["active", 10],
        orderBySql: "",
        limitNum: null,
        offsetNum: null,
        groupBy: [["category"]],
        havingSql: "(COUNT(*) > $3)",
        havingParams: [5],
      });
      expect(sql).toContain("WHERE");
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("HAVING");
      // Params must be in correct order: WHERE params first, then HAVING param
      expect(params).toEqual(["active", 10, 5]);
      // Placeholders must not collide
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
      expect(sql).toContain("$3");
      expect((sql.match(/\$1/g) ?? []).length).toBe(1);
      expect((sql.match(/\$2/g) ?? []).length).toBe(1);
      expect((sql.match(/\$3/g) ?? []).length).toBe(1);
    });

    it("compileSelect: HAVING + LIMIT/OFFSET placeholder sequence is contiguous", () => {
      const { sql, params } = postgresDialect.compileSelect({
        table: "orders",
        selectList: 'COUNT(*) AS "total"',
        whereSql: '("t0"."active" = $1)',
        whereParams: [true],
        orderBySql: "",
        limitNum: 10,
        offsetNum: 20,
        groupBy: [["category"]],
        havingSql: "(COUNT(*) > $2)",
        havingParams: [3],
      });
      // WHERE=$1, HAVING=$2, LIMIT=$3, OFFSET=$4
      expect(params).toEqual([true, 3, 10, 20]);
      expect(sql).toMatch(/HAVING.*\$2/);
      expect(sql).toMatch(/LIMIT \$3/);
      expect(sql).toMatch(/OFFSET \$4/);
    });

    it("compileSelect produces SELECT with LIMIT/OFFSET", () => {
      const { sql, params } = postgresDialect.compileSelect({
        table: "users",
        selectList: '"t0"."id", "t0"."name"',
        whereSql: "1=1",
        whereParams: [],
        orderBySql: '"t0"."name" ASC',
        limitNum: 10,
        offsetNum: 5,
      });
      expect(sql).toContain('SELECT "t0"."id", "t0"."name"');
      expect(sql).toContain('FROM "users"');
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT");
      expect(sql).toContain("OFFSET");
      expect(params).toEqual([10, 5]);
    });
  });

  describe("postgresMigrations", () => {
    it("generateSql produces valid DDL for add_table", () => {
      const action = {
        kind: "add_table" as const,
        table: "pg_test_users",
        schema: {
          id: "SERIAL PRIMARY KEY",
          name: "VARCHAR(255) NOT NULL",
        },
      };
      const sql = postgresMigrations.generateSql(action);
      expect(sql).toContain("CREATE TABLE");
      expect(sql).toContain('"pg_test_users"');
      expect(sql).toContain("SERIAL");
    });

    it("getTrackingTableDdl produces Postgres DDL", () => {
      const ddl = postgresMigrations.getTrackingTableDdl();
      expect(ddl).toContain("_typhex_migrations");
      expect(ddl).toContain("SERIAL");
      expect(ddl).toContain("DEFAULT NOW()");
    });

    it("getRecordMigrationSql uses $1 placeholder", () => {
      const sql = postgresMigrations.getRecordMigrationSql();
      expect(sql).toContain("INSERT INTO");
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
