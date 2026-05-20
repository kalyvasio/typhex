import { describe, it, expect } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriver } from "../../src/driver/factory.js";

describe("driver/factory", () => {
  it("creates sqlite driver with dialect and path", async () => {
    const driver = createDriver({ dialect: "sqlite", path: ":memory:" });
    expect(driver.dialect.name).toBe("sqlite");
    const rows = await driver.execute("SELECT 1 as x").then((r) => r.rows);
    expect(rows).toHaveLength(1);
    await driver.close();
  });

  it("creates sqlite driver with config compat (database as path)", async () => {
    const driver = createDriver({ dialect: "sqlite", database: ":memory:" });
    expect(driver.dialect.name).toBe("sqlite");
    await driver.close();
  });

  it("uses sqlite database option as the file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "typhex-driver-"));
    const database = join(await realpath(dir), "test.sqlite");
    const driver = createDriver({ dialect: "sqlite", database });
    try {
      const rows = await driver.execute("PRAGMA database_list").then((r) => r.rows);
      expect(rows).toContainEqual(expect.objectContaining({ file: database }));
    } finally {
      await driver.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates postgres driver with connectionString", async () => {
    const driver = createDriver({
      dialect: "postgres",
      connectionString: "postgresql://localhost:5432/typhex_test",
    });
    expect(driver.dialect.name).toBe("postgres");
    await driver.close();
  });

  it("creates postgres driver with url (config compat)", async () => {
    const driver = createDriver({
      dialect: "postgres",
      url: "postgresql://localhost:5432/typhex_test",
    });
    expect(driver.dialect.name).toBe("postgres");
    await driver.close();
  });

  it("creates postgres driver with host/port/database", async () => {
    const driver = createDriver({
      dialect: "postgres",
      host: "localhost",
      port: 5432,
      database: "typhex_test",
    });
    expect(driver.dialect.name).toBe("postgres");
    await driver.close();
  });

  it("throws for unknown dialect", () => {
    expect(() => createDriver({ dialect: "mysql" as "sqlite", path: ":memory:" })).toThrow(
      "Unknown dialect",
    );
  });
});
