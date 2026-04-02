import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import { Db } from "../../src/orm/db.js";
import { Entity } from "../../src/entity/entity.js";
import { clearRegistry, setDefaultDb } from "../../src/entity/global-driver.js";

describe("Db migration API (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearRegistry();
    setDefaultDb(null);
    tmpDir = mkdtempSync(join(tmpdir(), "typhex-db-mig-"));
  });

  afterEach(() => {
    setDefaultDb(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generateMigrations creates ordered .sql files for new entities", async () => {
    Entity("users", {
      id: "integer primary key autoincrement",
      name: "text not null",
    });
    Entity("posts", {
      id: "integer primary key autoincrement",
      user_id: "integer references users(id)",
      title: "text not null",
    });

    const db = new Db(createSqliteDriver({ path: ":memory:" }));
    const files = await db.generateMigrations(tmpDir);
    await db.close();

    expect(files.length).toBe(2);

    const usersIdx = files.findIndex((f) => f.name.includes("users"));
    const postsIdx = files.findIndex((f) => f.name.includes("posts"));
    expect(usersIdx).toBeLessThan(postsIdx);

    const written = readdirSync(tmpDir).sort();
    expect(written).toHaveLength(2);
    expect(written[0]).toMatch(/users_table\.sql$/);
    expect(written[1]).toMatch(/posts_table\.sql$/);
  });

  it("runMigrations applies generated scripts", async () => {
    Entity("accounts", {
      id: "integer primary key autoincrement",
      email: "text not null",
    });

    const db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.generateMigrations(tmpDir);
    const result = await db.runMigrations(tmpDir);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatch(/add_accounts_table/);

    const rows = await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'`);
    expect(rows).toHaveLength(1);

    await db.close();
  });

  it("generateMigrations returns empty when up to date", async () => {
    Entity("tags", { id: "integer primary key", name: "text" });
    const db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.migrate();

    const files = await db.generateMigrations(tmpDir);
    expect(files).toHaveLength(0);
    expect(readdirSync(tmpDir)).toHaveLength(0);
    await db.close();
  });

  it("generateMigrations detects added columns after initial migrate", async () => {
    Entity("users", { id: "integer primary key", name: "text" });
    const driver = createSqliteDriver({ path: ":memory:" });
    const db = new Db(driver);
    await db.migrate();

    clearRegistry();
    Entity("users", { id: "integer primary key", name: "text", age: "integer" });

    const files = await db.generateMigrations(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/add_age_column_on_users$/);
    expect(files[0].sql).toContain("ADD COLUMN");

    await db.close();
  });

  it("migrationStatus shows pending and applied", async () => {
    Entity("items", { id: "integer primary key", label: "text" });
    const db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.generateMigrations(tmpDir);

    const before = await db.migrationStatus(tmpDir);
    expect(before.applied).toHaveLength(0);
    expect(before.pending).toHaveLength(1);

    await db.runMigrations(tmpDir);
    const after = await db.migrationStatus(tmpDir);
    expect(after.applied).toHaveLength(1);
    expect(after.pending).toHaveLength(0);

    await db.close();
  });

  it("migrate() orders tables by FK dependencies", async () => {
    Entity("comments", {
      id: "integer primary key autoincrement",
      post_id: "integer references posts(id)",
      body: "text",
    });
    Entity("posts", {
      id: "integer primary key autoincrement",
      user_id: "integer references users(id)",
      title: "text",
    });
    Entity("users", {
      id: "integer primary key autoincrement",
      name: "text",
    });

    const driver = createSqliteDriver({ path: ":memory:" });
    await driver.execute("PRAGMA foreign_keys = ON");
    const db = new Db(driver);

    await expect(db.migrate()).resolves.not.toThrow();

    const tables = ((await driver.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).then(r => r.rows)) as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("users");
    expect(tables).toContain("posts");
    expect(tables).toContain("comments");

    await db.close();
  });
});
