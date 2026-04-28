import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import type { Driver } from "../../src/driver/types.js";
import {
  appliedMigrations,
  dryRunMigrations,
  migrationStatus,
  pendingMigrations,
  runMigrations,
  upMigration,
  downMigration,
} from "../../src/migration/runner.js";

/** Write a .js migration file with up/down functions for use in tests. */
function writeMigration(dir: string, name: string, upSql: string, downSql = ""): void {
  writeFileSync(
    join(dir, `${name}.js`),
    `export const upSql = ${JSON.stringify(upSql)};
export const downSql = ${JSON.stringify(downSql)};
export async function up(db) { if (upSql) await db.run(upSql); }
export async function down(db) { if (downSql) await db.run(downSql); }
`,
  );
}

describe("runMigrations", () => {
  let driver: Driver;
  let tmpDir: string;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
    tmpDir = mkdtempSync(join(tmpdir(), "typhex-runner-"));
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies all pending scripts in order", async () => {
    writeMigration(tmpDir, "001_add_users", 'CREATE TABLE "users" ("id" integer primary key)');
    writeMigration(tmpDir, "002_add_posts", 'CREATE TABLE "posts" ("id" integer primary key)');

    const result = await runMigrations(driver, tmpDir);
    expect(result.applied).toEqual(["001_add_users", "002_add_posts"]);
    expect(result.skipped).toEqual([]);

    const tables = (
      (await driver
        .execute(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .then((r) => r.rows)) as Array<{ name: string }>
    )
      .map((r) => r.name)
      .filter((n) => n !== "_typhex_migrations")
      .sort();
    expect(tables).toEqual(["posts", "users"]);
  });

  it("skips already-applied migrations", async () => {
    writeMigration(tmpDir, "001_add_users", 'CREATE TABLE "users" ("id" integer primary key)');
    await runMigrations(driver, tmpDir);

    writeMigration(tmpDir, "002_add_posts", 'CREATE TABLE "posts" ("id" integer primary key)');
    const result = await runMigrations(driver, tmpDir);
    expect(result.applied).toEqual(["002_add_posts"]);
    expect(result.skipped).toEqual(["001_add_users"]);
  });

  it("returns empty when no pending migrations", async () => {
    writeMigration(tmpDir, "001_add_users", 'CREATE TABLE "users" ("id" integer primary key)');
    await runMigrations(driver, tmpDir);

    const result = await runMigrations(driver, tmpDir);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["001_add_users"]);
  });

  it("records applied migrations in _typhex_migrations", async () => {
    writeMigration(tmpDir, "001_init", 'CREATE TABLE "t" ("id" integer primary key)');
    await runMigrations(driver, tmpDir);

    const rows = (await driver
      .execute(`SELECT "name" FROM "_typhex_migrations"`)
      .then((r) => r.rows)) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("001_init");
  });

  it("rolls back all in transaction on failure", async () => {
    writeMigration(tmpDir, "001_ok", 'CREATE TABLE "good" ("id" integer primary key)');
    writeMigration(tmpDir, "002_bad", "INVALID SQL SYNTAX");

    await expect(runMigrations(driver, tmpDir)).rejects.toThrow();

    const tables = (
      (await driver
        .execute(`SELECT name FROM sqlite_master WHERE type='table'`)
        .then((r) => r.rows)) as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).not.toContain("good");
  });

  it("records migrations with empty upSql as applied", async () => {
    writeMigration(tmpDir, "001_note", "");
    const result = await runMigrations(driver, tmpDir);
    expect(result.applied).toEqual(["001_note"]);
    expect(result.skipped).toEqual([]);
  });

  it("runs multi-statement SQL sequentially", async () => {
    writeMigration(
      tmpDir,
      "001_multi",
      'CREATE TABLE "users" ("id" integer primary key); CREATE TABLE "posts" ("id" integer primary key);',
    );

    await runMigrations(driver, tmpDir);

    const rows = (await driver
      .execute(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'posts')`)
      .then((r) => r.rows)) as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual(["posts", "users"]);
  });

  it("skips duplicate migration base names in one run", async () => {
    writeMigration(tmpDir, "001_init", 'CREATE TABLE "users" ("id" integer primary key)');
    writeFileSync(
      join(tmpDir, "001_init.mjs"),
      `export const upSql = "SELECT 1";
export const downSql = "";
export async function up(db) { await db.run(upSql); }
export async function down() {}
`,
    );

    const result = await runMigrations(driver, tmpDir);

    expect(result.applied).toEqual(["001_init"]);
  });
});

describe("migrationStatus", () => {
  let driver: Driver;
  let tmpDir: string;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
    tmpDir = mkdtempSync(join(tmpdir(), "typhex-status-"));
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns pending when nothing applied", async () => {
    writeMigration(tmpDir, "001_init", "SELECT 1");
    const status = await migrationStatus(driver, tmpDir);
    expect(status.applied).toHaveLength(0);
    expect(status.pending).toEqual(["001_init"]);
  });

  it("returns applied and pending", async () => {
    writeMigration(tmpDir, "001_a", 'CREATE TABLE "a" ("id" integer primary key)');
    writeMigration(tmpDir, "002_b", 'CREATE TABLE "b" ("id" integer primary key)');
    await runMigrations(driver, tmpDir);

    writeMigration(tmpDir, "003_c", 'CREATE TABLE "c" ("id" integer primary key)');
    const status = await migrationStatus(driver, tmpDir);
    expect(status.applied).toHaveLength(2);
    expect(status.pending).toEqual(["003_c"]);
  });

  it("handles missing migrations directory gracefully", async () => {
    const status = await migrationStatus(driver, "/nonexistent/path");
    expect(status.applied).toHaveLength(0);
    expect(status.pending).toHaveLength(0);
  });

  it("rethrows non-ENOENT errors (e.g. ENOTDIR when path is a file)", async () => {
    const filePath = join(tmpDir, "not-a-dir");
    writeFileSync(filePath, "");
    await expect(migrationStatus(driver, filePath)).rejects.toThrow();
  });
});

describe("migration workflow helpers", () => {
  let driver: Driver;
  let tmpDir: string;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
    tmpDir = mkdtempSync(join(tmpdir(), "typhex-workflow-"));
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns applied migration records", async () => {
    writeMigration(tmpDir, "001_init", 'CREATE TABLE "users" ("id" integer primary key)');
    await runMigrations(driver, tmpDir);

    const applied = await appliedMigrations(driver);
    expect(applied.map((m) => m.name)).toEqual(["001_init"]);
  });

  it("returns pending migrations with upSql and downSql", async () => {
    writeMigration(
      tmpDir,
      "001_init",
      'CREATE TABLE "users" ("id" integer primary key)',
      'DROP TABLE "users"',
    );

    const pending = await pendingMigrations(driver, tmpDir);
    expect(pending.map((m) => m.name)).toEqual(["001_init"]);
    expect(pending[0].upSql).toBe('CREATE TABLE "users" ("id" integer primary key)');
    expect(pending[0].downSql).toBe('DROP TABLE "users"');
  });

  it("reads pending SQL without importing migration modules", async () => {
    const marker = join(tmpDir, "imported.txt");
    writeFileSync(
      join(tmpDir, "001_side_effect.js"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export const upSql = "SELECT 1";
export const downSql = "";
export async function up(db) { await db.run(upSql); }
export async function down() {}
`,
    );

    const pending = await pendingMigrations(driver, tmpDir);

    expect(pending.map((m) => m.name)).toEqual(["001_side_effect"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("dry-runs without applying migrations", async () => {
    writeMigration(tmpDir, "001_init", 'CREATE TABLE "users" ("id" integer primary key)');

    const plan = await dryRunMigrations(driver, tmpDir);
    expect(plan.pending.map((m) => m.name)).toEqual(["001_init"]);

    const rows = await driver.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = 'users'`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("dry-run keeps SQL after leading comments", async () => {
    writeMigration(
      tmpDir,
      "001_init",
      '-- add users\nCREATE TABLE "users" ("id" integer primary key);',
    );

    const plan = await dryRunMigrations(driver, tmpDir);

    expect(plan.pending[0].statements).toEqual([
      '-- add users\nCREATE TABLE "users" ("id" integer primary key)',
    ]);
  });

  it("dry-run reports applied migrations as skipped", async () => {
    writeMigration(tmpDir, "001_init", 'CREATE TABLE "users" ("id" integer primary key)');
    await runMigrations(driver, tmpDir);
    writeMigration(tmpDir, "002_next", 'CREATE TABLE "posts" ("id" integer primary key)');

    const plan = await dryRunMigrations(driver, tmpDir);
    expect(plan.pending.map((m) => m.name)).toEqual(["002_next"]);
    expect(plan.skipped).toEqual(["001_init"]);
  });
});

describe("upMigration / downMigration", () => {
  let driver: Driver;
  let tmpDir: string;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
    tmpDir = mkdtempSync(join(tmpdir(), "typhex-updown-"));
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upMigration applies a specific migration and records it", async () => {
    writeMigration(tmpDir, "001_init", 'CREATE TABLE "users" ("id" integer primary key)');
    await upMigration(driver, tmpDir, "001_init");

    const rows = (await driver
      .execute(`SELECT "name" FROM "_typhex_migrations"`)
      .then((r) => r.rows)) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("001_init");

    const tables = (await driver
      .execute(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'users'`)
      .then((r) => r.rows)) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it("upMigration throws if migration is already applied", async () => {
    writeMigration(tmpDir, "001_init", 'CREATE TABLE "users" ("id" integer primary key)');
    await upMigration(driver, tmpDir, "001_init");

    await expect(upMigration(driver, tmpDir, "001_init")).rejects.toThrow(/already applied/);
  });

  it("upMigration throws if migration file does not exist", async () => {
    await expect(upMigration(driver, tmpDir, "999_missing")).rejects.toThrow(/not found/);
  });

  it("upMigration throws not found when migration path is not a directory", async () => {
    const filePath = join(tmpDir, "not-a-dir");
    writeFileSync(filePath, "");

    await expect(upMigration(driver, filePath, "001_init")).rejects.toThrow(/not found/);
  });

  it("upMigration rolls back on SQL failure", async () => {
    writeMigration(
      tmpDir,
      "001_init",
      'CREATE TABLE "users" ("id" integer primary key); INVALID SQL',
    );
    await expect(upMigration(driver, tmpDir, "001_init")).rejects.toThrow();

    const rows = (await driver
      .execute(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'users'`)
      .then((r) => r.rows)) as Array<unknown>;
    expect(rows).toHaveLength(0);
  });

  it("downMigration rolls back an applied migration and removes its record", async () => {
    writeMigration(
      tmpDir,
      "001_init",
      'CREATE TABLE "users" ("id" integer primary key)',
      'DROP TABLE "users"',
    );
    await upMigration(driver, tmpDir, "001_init");

    await downMigration(driver, tmpDir, "001_init");

    const rows = (await driver
      .execute(`SELECT "name" FROM "_typhex_migrations"`)
      .then((r) => r.rows)) as Array<unknown>;
    expect(rows).toHaveLength(0);

    const tables = (await driver
      .execute(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'users'`)
      .then((r) => r.rows)) as Array<unknown>;
    expect(tables).toHaveLength(0);
  });

  it("downMigration throws if migration is not applied", async () => {
    writeMigration(
      tmpDir,
      "001_init",
      'CREATE TABLE "users" ("id" integer primary key)',
      'DROP TABLE "users"',
    );
    await expect(downMigration(driver, tmpDir, "001_init")).rejects.toThrow(/not applied/);
  });

  it("downMigration throws if migration file does not exist", async () => {
    // Manually insert a tracking record without a corresponding file
    await driver.execute(
      `CREATE TABLE IF NOT EXISTS "_typhex_migrations" ("id" integer primary key autoincrement, "name" text not null unique, "applied_at" text not null default (datetime('now')))`,
    );
    await driver.execute(`INSERT INTO "_typhex_migrations" ("name") VALUES (?)`, ["999_ghost"]);

    await expect(downMigration(driver, tmpDir, "999_ghost")).rejects.toThrow(/not found/);
  });

  it("downMigration rolls back on SQL failure and leaves record intact", async () => {
    writeMigration(
      tmpDir,
      "001_init",
      'CREATE TABLE "users" ("id" integer primary key)',
      "INVALID SQL",
    );
    await upMigration(driver, tmpDir, "001_init");

    await expect(downMigration(driver, tmpDir, "001_init")).rejects.toThrow();

    const rows = (await driver
      .execute(`SELECT "name" FROM "_typhex_migrations"`)
      .then((r) => r.rows)) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
  });
});
