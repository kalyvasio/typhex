import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPostgresDriver,
  postgresDialect,
  postgresMigrations,
  getDialect,
} from "../../src/dbs/index.js";
import { Entity } from "../../src/entity/entity.js";
import { Db } from "../../src/orm/db.js";
import { clearRegistry, setDefaultDriver } from "../../src/entity/global-driver.js";

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
    setDefaultDriver(null);
  });

  describe("postgresDialect", () => {
    it("uses $1, $2 placeholders", () => {
      expect(postgresDialect.placeholder(1)).toBe("$1");
      expect(postgresDialect.placeholder(2)).toBe("$2");
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

    it("compileInsert produces INSERT with RETURNING * and returningRow", () => {
      const result = postgresDialect.compileInsert(
        "users",
        ["name", "age"],
        ["Alice", 30],
        "id"
      );
      expect(result.sql).toContain('INSERT INTO "users"');
      expect(result.sql).toContain("$1");
      expect(result.sql).toContain("RETURNING *");
      expect(result.params).toEqual(["Alice", 30]);
      expect(result.returningRow).toBe(true);
    });

    it("compileCount produces SELECT COUNT", () => {
      const { sql, params } = postgresDialect.compileCount("users", '"t0"."age" = $1', [18]);
      expect(sql).toContain('SELECT COUNT(*) AS c');
      expect(sql).toContain('FROM "users"');
      expect(params).toEqual([18]);
    });

    it("compileUpdate produces UPDATE with renumbered placeholders", () => {
      const { sql, params } = postgresDialect.compileUpdate(
        "users",
        { name: "Bob" },
        ["id", "name"],
        '"t0"."id" = $1',
        [1]
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
          const rows = await driver.query("SELECT 1 as x");
          expect(rows).toHaveLength(1);
          expect((rows[0] as { x: number }).x).toBe(1);
        } finally {
          await driver.close();
        }
      },
      { skip: !hasPostgres() }
    );

    it(
      "supports concurrent queries via connection pooling",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString, poolMin: 2, poolMax: 5 });
        try {
          // Fire multiple concurrent queries to exercise the pool
          const results = await Promise.all([
            driver.query("SELECT 1 as n"),
            driver.query("SELECT 2 as n"),
            driver.query("SELECT 3 as n"),
            driver.query("SELECT 4 as n"),
            driver.query("SELECT 5 as n"),
          ]);
          expect(results).toHaveLength(5);
          results.forEach((rows, i) => {
            expect(rows).toHaveLength(1);
            expect((rows[0] as { n: number }).n).toBe(i + 1);
          });
        } finally {
          await driver.close();
        }
      },
      { skip: !hasPostgres() }
    );

    it(
      "rolls back transaction on error",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString });
        try {
          await driver.run("DROP TABLE IF EXISTS pg_tx_rollback_test");
          await driver.run("CREATE TABLE pg_tx_rollback_test (id SERIAL PRIMARY KEY, val TEXT)");

          await expect(
            driver.transaction(async () => {
              await driver.run("INSERT INTO pg_tx_rollback_test (val) VALUES ($1)", ["should-rollback"]);
              throw new Error("intentional rollback");
            })
          ).rejects.toThrow("intentional rollback");

          const rows = await driver.query("SELECT * FROM pg_tx_rollback_test");
          expect(rows).toHaveLength(0);
        } finally {
          await driver.run("DROP TABLE IF EXISTS pg_tx_rollback_test");
          await driver.close();
        }
      },
      { skip: !hasPostgres() }
    );

    it(
      "wraps errors with SQL context",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString });
        try {
          await expect(
            driver.query("SELECT * FROM nonexistent_table_xyz_typhex")
          ).rejects.toThrow(/PG\([\s\S]*SQL:\s*SELECT \* FROM nonexistent_table_xyz_typhex/);
        } finally {
          await driver.close();
        }
      },
      { skip: !hasPostgres() }
    );

    it(
      "closes pool cleanly",
      async () => {
        if (!hasPostgres()) return;
        const driver = createPostgresDriver({ connectionString });
        // Run a query to ensure pool is active
        await driver.query("SELECT 1");
        // close() should resolve without error
        await expect(driver.close()).resolves.toBeUndefined();
      },
      { skip: !hasPostgres() }
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
        const db = new Db(driver);
        setDefaultDriver(driver);

        try {
          await driver.run('DROP TABLE IF EXISTS "pg_test_users"');
          await db.migrate();

          const u = await User.query().insert({ name: "Alice", age: 30 });
          expect(u.id).toBe(1);

          const found = await User.query().where((u) => u.name === "Alice").first();
          expect(found?.name).toBe("Alice");

          const count = await User.query().count();
          expect(count).toBe(1);
        } finally {
          await db.close();
        }
      },
      { skip: !hasPostgres() }
    );
  });
});
