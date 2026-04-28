import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import type { Driver } from "../../src/driver/types.js";
import { generateMigrationFiles, writeMigrationFiles } from "../../src/migration/generator.js";
import type { RegisteredEntity } from "../../src/entity/global-driver.js";

function entity(table: string, schema: Record<string, string>): RegisteredEntity {
  return { table: { _table: table, _schema: schema } };
}

describe("generateMigrationFiles", () => {
  let driver: Driver;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
  });

  afterEach(async () => {
    await driver.close();
  });

  it("returns empty array when schema is in sync", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "name" text)`);
    const files = await generateMigrationFiles(driver, [
      entity("users", { id: "integer primary key", name: "text" }),
    ]);
    expect(files).toHaveLength(0);
  });

  it("generates add_table script for new entities", async () => {
    const files = await generateMigrationFiles(driver, [
      entity("users", { id: "integer primary key", name: "text not null" }),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/add_users_table$/);
    expect(files[0].upSql).toContain("CREATE TABLE");
    expect(files[0].upSql).toContain('"users"');
  });

  it("generates add_column script", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key)`);
    const files = await generateMigrationFiles(driver, [
      entity("users", { id: "integer primary key", email: "text" }),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/add_email_column_on_users$/);
    expect(files[0].upSql).toContain("ADD COLUMN");
  });

  it("generates drop_table script for database tables removed from entities", async () => {
    await driver.execute(`CREATE TABLE "legacy" ("id" integer primary key)`);

    const files = await generateMigrationFiles(driver, []);

    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/drop_legacy_table$/);
    expect(files[0].upSql).toContain('DROP TABLE IF EXISTS "legacy"');
    expect(files[0].downSql).toContain('CREATE TABLE IF NOT EXISTS "legacy"');
  });

  it("generates drop_column script for columns removed from entities", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "legacy" text)`);

    const files = await generateMigrationFiles(driver, [
      entity("users", { id: "integer primary key" }),
    ]);

    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/drop_legacy_column_on_users$/);
    expect(files[0].upSql).toContain('DROP COLUMN "legacy"');
    expect(files[0].downSql).toContain('ADD COLUMN "legacy" TEXT');
  });

  it("throws on alter_column for SQLite (no native ALTER COLUMN support)", async () => {
    await driver.execute(`CREATE TABLE "users" ("id" integer primary key, "age" text)`);

    await expect(
      generateMigrationFiles(driver, [
        entity("users", { id: "integer primary key", age: "integer" }),
      ]),
    ).rejects.toThrow(/SQLite cannot apply ALTER COLUMN on users\.age/);
  });

  it("orders tables by FK dependencies", async () => {
    const entities = [
      entity("comments", { id: "integer primary key", post_id: "integer references posts(id)" }),
      entity("posts", { id: "integer primary key", user_id: "integer references users(id)" }),
      entity("users", { id: "integer primary key", name: "text" }),
    ];
    const files = await generateMigrationFiles(driver, entities);
    const names = files.map((f) => f.name);
    const usersIdx = names.findIndex((n) => n.includes("users"));
    const postsIdx = names.findIndex((n) => n.includes("posts"));
    const commentsIdx = names.findIndex((n) => n.includes("comments"));
    expect(usersIdx).toBeLessThan(postsIdx);
    expect(postsIdx).toBeLessThan(commentsIdx);
  });

  it("generates timestamped sequential names", async () => {
    const files = await generateMigrationFiles(driver, [
      entity("users", { id: "integer primary key" }),
      entity("posts", { id: "integer primary key" }),
    ]);
    expect(files).toHaveLength(2);
    expect(files[0].name).toMatch(/^\d{14}01_add_users_table$/);
    expect(files[1].name).toMatch(/^\d{14}02_add_posts_table$/);
  });

  it("escapes template interpolation in generated modules", async () => {
    const files = await generateMigrationFiles(driver, [
      entity("users", { id: "integer primary key", name: "text default '${name}'" }),
    ]);

    expect(files[0].content).toContain("\\${name}");
  });
});

describe("writeMigrationFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "typhex-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes .js files to the directory", () => {
    const files = [
      {
        name: "2026_add_users_table",
        upSql: "CREATE TABLE users (id int);",
        downSql: "",
        content: "export const upSql = `CREATE TABLE users (id int);`;",
      },
      {
        name: "2026_add_posts_table",
        upSql: "CREATE TABLE posts (id int);",
        downSql: "",
        content: "export const upSql = `CREATE TABLE posts (id int);`;",
      },
    ];
    const paths = writeMigrationFiles(tmpDir, files);
    expect(paths).toHaveLength(2);
    const written = readdirSync(tmpDir).sort();
    expect(written).toEqual(["2026_add_posts_table.js", "2026_add_users_table.js"]);
    expect(readFileSync(paths[0], "utf-8")).toContain("CREATE TABLE users");
  });

  it("creates the directory if it does not exist", () => {
    const nested = join(tmpDir, "deep", "dir");
    writeMigrationFiles(nested, [
      {
        name: "test",
        upSql: "SELECT 1;",
        downSql: "",
        content: "export const upSql = `SELECT 1;`;",
      },
    ]);
    expect(readdirSync(nested)).toEqual(["test.js"]);
  });
});
