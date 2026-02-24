import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db } from "../../src/orm/db.js";
import { Entity } from "../../src/entity/entity.js";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import { getDefaultDriver, setDefaultDriver, clearRegistry } from "../../src/entity/global-driver.js";
import type { Driver } from "../../src/driver/types.js";

function freshDriver(): Driver {
  return createSqliteDriver({ path: ":memory:" });
}

describe("Db", () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    setDefaultDriver(null);
  });

  describe("constructor", () => {
    it("sets the global default driver", () => {
      expect(getDefaultDriver()).toBeNull();
      const driver = freshDriver();
      const db = new Db(driver);
      expect(getDefaultDriver()).toBe(driver);
      db.close();
    });
  });

  describe("getDriver()", () => {
    it("returns the underlying driver", () => {
      const driver = freshDriver();
      const db = new Db(driver);
      expect(db.getDriver()).toBe(driver);
      db.close();
    });
  });

  describe("close()", () => {
    it("clears the global default driver", () => {
      const db = new Db(freshDriver());
      expect(getDefaultDriver()).not.toBeNull();
      db.close();
      expect(getDefaultDriver()).toBeNull();
    });
  });

  describe("migrate()", () => {
    it("creates tables for all registered entities", async () => {
      const User = Entity("mig_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      db.migrate();
      await User.create({ name: "Alice" });
      expect(await User.query().count()).toBe(1);
      db.close();
    });

    it("is idempotent (IF NOT EXISTS)", async () => {
      const User = Entity("mig_idem", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      db.migrate();
      db.migrate();
      await User.create({ name: "Alice" });
      expect(await User.query().count()).toBe(1);
      db.close();
    });
  });

  describe("validate()", () => {
    it("passes when schema matches the database", () => {
      Entity("val_users2", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      db.migrate();
      expect(() => db.validate()).not.toThrow();
      db.close();
    });

    it("throws when table does not exist", () => {
      Entity("val_ghost2", { id: "integer primary key" });
      const db = new Db(freshDriver());
      expect(() => db.validate()).toThrow("does not exist");
      db.close();
    });

    it("throws when a column is missing from the database", () => {
      const driver = freshDriver();
      driver.run(`CREATE TABLE "val_partial2" ("id" integer primary key)`);
      Entity("val_partial2", {
        id: "integer primary key",
        name: "text",
      });
      const db = new Db(driver);
      expect(() => db.validate()).toThrow('column "name"');
      db.close();
    });
  });
});
