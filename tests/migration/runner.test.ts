import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import type { Driver } from "../../src/driver/types.js";
import { runMigrations, migrationStatus } from "../../src/migration/runner.js";

describe("runMigrations", () => {
  let driver: Driver;
  let tmpDir: string;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
    tmpDir = mkdtempSync(join(tmpdir(), "typhex-runner-"));
  });

  afterEach(() => {
    driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies all pending scripts in order", () => {
    writeFileSync(join(tmpDir, "001_add_users.sql"), 'CREATE TABLE "users" ("id" integer primary key);');
    writeFileSync(join(tmpDir, "002_add_posts.sql"), 'CREATE TABLE "posts" ("id" integer primary key);');

    const result = runMigrations(driver, tmpDir);
    expect(result.applied).toEqual(["001_add_users", "002_add_posts"]);
    expect(result.skipped).toEqual([]);

    const tables = (driver.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`) as Array<{ name: string }>)
      .map((r) => r.name)
      .filter((n) => n !== "_typhex_migrations")
      .sort();
    expect(tables).toEqual(["posts", "users"]);
  });

  it("skips already-applied migrations", () => {
    writeFileSync(join(tmpDir, "001_add_users.sql"), 'CREATE TABLE "users" ("id" integer primary key);');
    runMigrations(driver, tmpDir);

    writeFileSync(join(tmpDir, "002_add_posts.sql"), 'CREATE TABLE "posts" ("id" integer primary key);');
    const result = runMigrations(driver, tmpDir);
    expect(result.applied).toEqual(["002_add_posts"]);
    expect(result.skipped).toEqual(["001_add_users"]);
  });

  it("returns empty when no pending migrations", () => {
    writeFileSync(join(tmpDir, "001_add_users.sql"), 'CREATE TABLE "users" ("id" integer primary key);');
    runMigrations(driver, tmpDir);

    const result = runMigrations(driver, tmpDir);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["001_add_users"]);
  });

  it("records applied migrations in _typhex_migrations", () => {
    writeFileSync(join(tmpDir, "001_init.sql"), 'CREATE TABLE "t" ("id" integer primary key);');
    runMigrations(driver, tmpDir);

    const rows = driver.query(`SELECT "name" FROM "_typhex_migrations"`) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("001_init");
  });

  it("rolls back all in transaction on failure", () => {
    writeFileSync(join(tmpDir, "001_ok.sql"), 'CREATE TABLE "good" ("id" integer primary key);');
    writeFileSync(join(tmpDir, "002_bad.sql"), "INVALID SQL SYNTAX;");

    expect(() => runMigrations(driver, tmpDir)).toThrow();

    const tables = (driver.query(`SELECT name FROM sqlite_master WHERE type='table'`) as Array<{ name: string }>)
      .map((r) => r.name);
    expect(tables).not.toContain("good");
  });

  it("skips comment-only .sql files", () => {
    writeFileSync(join(tmpDir, "001_note.sql"), "-- This is a note\n-- Nothing here");
    const result = runMigrations(driver, tmpDir);
    expect(result.skipped).toEqual(["001_note"]);
    expect(result.applied).toEqual([]);
  });
});

describe("migrationStatus", () => {
  let driver: Driver;
  let tmpDir: string;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
    tmpDir = mkdtempSync(join(tmpdir(), "typhex-status-"));
  });

  afterEach(() => {
    driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns pending when nothing applied", () => {
    writeFileSync(join(tmpDir, "001_init.sql"), "SELECT 1;");
    const status = migrationStatus(driver, tmpDir);
    expect(status.applied).toHaveLength(0);
    expect(status.pending).toEqual(["001_init"]);
  });

  it("returns applied and pending", () => {
    writeFileSync(join(tmpDir, "001_a.sql"), 'CREATE TABLE "a" ("id" integer primary key);');
    writeFileSync(join(tmpDir, "002_b.sql"), 'CREATE TABLE "b" ("id" integer primary key);');
    runMigrations(driver, tmpDir);

    writeFileSync(join(tmpDir, "003_c.sql"), 'CREATE TABLE "c" ("id" integer primary key);');
    const status = migrationStatus(driver, tmpDir);
    expect(status.applied).toHaveLength(2);
    expect(status.pending).toEqual(["003_c"]);
  });

  it("handles missing migrations directory gracefully", () => {
    const status = migrationStatus(driver, "/nonexistent/path");
    expect(status.applied).toHaveLength(0);
    expect(status.pending).toHaveLength(0);
  });

  it("rethrows non-ENOENT errors (e.g. ENOTDIR when path is a file)", () => {
    const filePath = join(tmpDir, "not-a-dir");
    writeFileSync(filePath, "");
    expect(() => migrationStatus(driver, filePath)).toThrow();
  });
});
