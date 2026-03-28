import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {Db, getActiveTrx, Trx} from "../../src/orm/db.js";
import { Entity } from "../../src/entity/entity.js";
import { getDefaultDb, setDefaultDb, clearRegistry } from "../../src/entity/global-driver.js";
import { freshDriver } from "../helpers.js";

describe("Db", () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    setDefaultDb(null);
  });

  describe("constructor", () => {
    it("sets the global default Db", async () => {
      expect(getDefaultDb()).toBeNull();
      const driver = freshDriver();
      const db = new Db(driver);
      expect(getDefaultDb()).toBe(db);
      await db.close();
    });
  });

  describe("getDriver()", () => {
    it("returns the underlying driver", async () => {
      const driver = freshDriver();
      const db = new Db(driver);
      expect(db.getDriver()).toBe(driver);
      await db.close();
    });
  });

  describe("close()", () => {
    it("clears the global default Db", async () => {
      const db = new Db(freshDriver());
      expect(getDefaultDb()).not.toBeNull();
      await db.close();
      expect(getDefaultDb()).toBeNull();
    });
  });

  describe("migrate()", () => {
    it("creates tables for all registered entities", async () => {
      const User = Entity("mig_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await User.query().insert({ name: "Alice" });
      expect(await User.query().count()).toBe(1);
      await db.close();
    });

    it("is idempotent (IF NOT EXISTS)", async () => {
      const User = Entity("mig_idem", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await db.migrate();
      await User.query().insert({ name: "Alice" });
      expect(await User.query().count()).toBe(1);
      await db.close();
    });
  });

  describe("transaction()", () => {
    it("commits successfully", async () => {
      const TxUser = Entity("tx_commit_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await db.transaction(async (trx) => {
        await TxUser.query(trx).insert({ name: "Alice" });
        await TxUser.query(trx).insert({ name: "Bob" });
      });
      expect(await TxUser.query().count()).toBe(2);
      await db.close();
    });

    it("rolls back on error", async () => {
      const TxUser2 = Entity("tx_rollback_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await expect(
        db.transaction(async (trx) => {
          await TxUser2.query(trx).insert({ name: "Alice" });
          throw new Error("intentional rollback");
        })
      ).rejects.toThrow("intentional rollback");
      expect(await TxUser2.query().count()).toBe(0);
      await db.close();
    });

    it("count is 0 after rollback", async () => {
      const TxUser3 = Entity("tx_count_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      try {
        await db.transaction(async (trx) => {
          await TxUser3.query(trx).insert({ name: "Charlie" });
          throw new Error("abort");
        });
      } catch {
        // expected
      }
      expect(await TxUser3.query().count()).toBe(0);
      await db.close();
    });

    it("Entity.transaction() works via static method", async () => {
      const TxEntity = Entity("tx_entity_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await TxEntity.transaction(async (trx) => {
        await TxEntity.query(trx).insert({ name: "Dave" });
      });
      expect(await TxEntity.query().count()).toBe(1);
      await db.close();
    });

    it("nested transactions via savepoints (SQLite)", async () => {
      const TxNested = Entity("tx_nested_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await db.transaction(async (trx) => {
        await TxNested.query(trx).insert({ name: "Outer" });
        await trx.transaction(async (innerTrx) => {
          await TxNested.query(innerTrx).insert({ name: "Inner" });
        });
      });
      expect(await TxNested.query().count()).toBe(2);
      await db.close();
    });

    it("nested transaction rollback rolls back only inner savepoint", async () => {
      const TxNestedRollback = Entity("tx_nested_rollback_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await db.transaction(async (trx) => {
        await TxNestedRollback.query(trx).insert({ name: "Outer" });
        await expect(
          trx.transaction(async (innerTrx) => {
            await TxNestedRollback.query(innerTrx).insert({ name: "Inner" });
            throw new Error("inner rollback");
          })
        ).rejects.toThrow("inner rollback");
      });
      expect(await TxNestedRollback.query().count()).toBe(1);
      const rows = await TxNestedRollback.query().toArray();
      expect((rows[0] as any).name).toBe("Outer");
      await db.close();
    });

    it("accepts isolationLevel option", async () => {
      const TxIsolation = Entity("tx_isolation_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await db.transaction(
        async (trx) => {
          await TxIsolation.query(trx).insert({ name: "Isolated" });
        },
        { isolationLevel: "SERIALIZABLE" }
      );
      expect(await TxIsolation.query().count()).toBe(1);
      await db.close();
    });

    describe("AsyncLocalStorage implicit propagation", () => {
      it("Entity.query() without arg uses ALS trx inside transaction", async () => {
        const AlsUser = Entity("als_commit_users", {
          id: "integer primary key autoincrement",
          name: "text not null",
        });
        const db = new Db(freshDriver());
        await db.migrate();
        await db.transaction(async () => {
          await AlsUser.query().insert({ name: "Alice" });
          await AlsUser.query().insert({ name: "Bob" });
        });
        expect(await AlsUser.query().count()).toBe(2);
        await db.close();
      });

      it("implicit trx rolls back on error", async () => {
        const AlsRollback = Entity("als_rollback_users", {
          id: "integer primary key autoincrement",
          name: "text not null",
        });
        const db = new Db(freshDriver());
        await db.migrate();
        await expect(
          db.transaction(async () => {
            await AlsRollback.query().insert({ name: "Alice" });
            throw new Error("rollback");
          })
        ).rejects.toThrow("rollback");
        expect(await AlsRollback.query().count()).toBe(0);
        await db.close();
      });

      it("ALS trx is not visible outside the transaction", async () => {
        const db = new Db(freshDriver());
        expect(getActiveTrx()).toBeUndefined();
        let trxInsideCallback: unknown;
        await db.transaction(async () => {
          trxInsideCallback = getActiveTrx();
        });
        expect(trxInsideCallback).toBeDefined();
        expect(getActiveTrx()).toBeUndefined();
        await db.close();
      });

      it("Trx extends Db — explicit trx is assignable to Db", async () => {
        const db = new Db(freshDriver());
        await db.transaction(async (trx) => {
          expect(trx).toBeInstanceOf(Trx);
        });
        await db.close();
      });
    });
  });

  describe("beginTrx() — explicit transaction API", () => {
    it("commits when trx.commit() is called", async () => {
      const ExplicitUser = Entity("explicit_commit_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      const trx = await db.beginTrx();
      await ExplicitUser.query(trx).insert({ name: "Alice" });
      await ExplicitUser.query(trx).insert({ name: "Bob" });
      await trx.commit();
      expect(await ExplicitUser.query().count()).toBe(2);
      await db.close();
    });

    it("rolls back when trx.rollback() is called", async () => {
      const ExplicitRb = Entity("explicit_rollback_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      const trx = await db.beginTrx();
      await ExplicitRb.query(trx).insert({ name: "Alice" });
      await trx.rollback();
      expect(await ExplicitRb.query().count()).toBe(0);
      await db.close();
    });

    it("nested trx.beginTrx() + commit persists inner rows", async () => {
      const ExpNested = Entity("explicit_nested_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      const trx = await db.beginTrx();
      await ExpNested.query(trx).insert({ name: "Alice" });
      const nested = await trx.beginTrx();
      await ExpNested.query(nested).insert({ name: "Bob" });
      await nested.commit();
      await trx.commit();
      expect(await ExpNested.query().count()).toBe(2);
      await db.close();
    });

    it("nested rollback discards only inner rows, outer commit keeps outer rows", async () => {
      const ExpPartial = Entity("explicit_partial_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      const trx = await db.beginTrx();
      await ExpPartial.query(trx).insert({ name: "Alice" });
      const nested = await trx.beginTrx();
      await ExpPartial.query(nested).insert({ name: "Bob" });
      await nested.rollback();  // only Bob is rolled back
      await trx.commit();
      const rows = await ExpPartial.query().toArray();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).name).toBe("Alice");
      await db.close();
    });

    it("accepts isolationLevel option", async () => {
      const IsoUser = Entity("explicit_iso_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      const trx = await db.beginTrx({ isolationLevel: "SERIALIZABLE" });
      await IsoUser.query(trx).insert({ name: "Alice" });
      await trx.commit();
      expect(await IsoUser.query().count()).toBe(1);
      await db.close();
    });

    it("double rollback is safe", async () => {
      const DblRb = Entity("double_rollback_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      const trx = await db.beginTrx();
      await DblRb.query(trx).insert({ name: "Alice" });
      await trx.rollback();
      // Second rollback should not throw (SQLite ignores it)
      await expect(trx.rollback()).resolves.not.toThrow();
      await db.close();
    });
  });

  describe("TransactionOptions — validation", () => {
    // SQLite: unsupported ANSI isolation levels
    it("SQLite throws when READ_COMMITTED is used", async () => {
      const db = new Db(freshDriver());
      await expect(
        db.beginTrx({ isolationLevel: "READ_COMMITTED" })
      ).rejects.toThrow(/does not support/);
      await db.close();
    });

    it("SQLite throws when READ_UNCOMMITTED is used", async () => {
      const db = new Db(freshDriver());
      await expect(
        db.beginTrx({ isolationLevel: "READ_UNCOMMITTED" })
      ).rejects.toThrow(/does not support/);
      await db.close();
    });

    it("SQLite throws when REPEATABLE_READ is used", async () => {
      const db = new Db(freshDriver());
      await expect(
        db.beginTrx({ isolationLevel: "REPEATABLE_READ" })
      ).rejects.toThrow(/does not support/);
      await db.close();
    });

    // SQLite: postgres-only options
    it("SQLite throws when readOnly is set", async () => {
      const db = new Db(freshDriver());
      await expect(
        db.beginTrx({ readOnly: true })
      ).rejects.toThrow(/readOnly.*not supported by SQLite/);
      await db.close();
    });

    it("SQLite throws when deferrable is set", async () => {
      const db = new Db(freshDriver());
      await expect(
        db.beginTrx({ deferrable: true })
      ).rejects.toThrow(/deferrable.*not supported by SQLite/);
      await db.close();
    });

    // SQLite: mutually exclusive options
    it("SQLite throws when both sqliteMode and isolationLevel are set", async () => {
      const db = new Db(freshDriver());
      await expect(
        db.beginTrx({ sqliteMode: "immediate", isolationLevel: "SERIALIZABLE" })
      ).rejects.toThrow(/mutually exclusive/);
      await db.close();
    });

    // SQLite: valid modes
    it("sqliteMode: 'exclusive' opens a transaction and commits", async () => {
      const ExclUser = Entity("exclusive_mode_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      const trx = await db.beginTrx({ sqliteMode: "exclusive" });
      await ExclUser.query(trx).insert({ name: "Alice" });
      await trx.commit();
      expect(await ExclUser.query().count()).toBe(1);
      await db.close();
    });

    it("sqliteMode: 'deferred' opens a transaction and commits", async () => {
      const DeferUser = Entity("deferred_mode_users", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      const trx = await db.beginTrx({ sqliteMode: "deferred" });
      await DeferUser.query(trx).insert({ name: "Bob" });
      await trx.commit();
      expect(await DeferUser.query().count()).toBe(1);
      await db.close();
    });
  });

  describe("TransactionOptions — Postgres-specific validation (unit, no DB required)", () => {
    // validateOptions() is called in the constructor, so construction itself throws.

    it("PostgresTrx throws when sqliteMode is set", async () => {
      const { PostgresTrx } = await import("../../src/dbs/postgres/trx.js");
      const mockConn = {
        dialect: "postgres" as const,
        execute: async () => ({ rows: [], changes: 0 }),
        release: async () => {},
      };
      expect(() => new (PostgresTrx as any)(mockConn, { sqliteMode: "immediate" }))
        .toThrow(/sqliteMode.*not supported by PostgreSQL/);
    });

    it("PostgresTrx throws when deferrable is set without SERIALIZABLE", async () => {
      const { PostgresTrx } = await import("../../src/dbs/postgres/trx.js");
      const mockConn = {
        dialect: "postgres" as const,
        execute: async () => ({ rows: [], changes: 0 }),
        release: async () => {},
      };
      expect(() => new (PostgresTrx as any)(mockConn, { deferrable: true, readOnly: true }))
        .toThrow(/deferrable requires isolationLevel/);
    });

    it("PostgresTrx throws when deferrable is set without readOnly", async () => {
      const { PostgresTrx } = await import("../../src/dbs/postgres/trx.js");
      const mockConn = {
        dialect: "postgres" as const,
        execute: async () => ({ rows: [], changes: 0 }),
        release: async () => {},
      };
      expect(() => new (PostgresTrx as any)(mockConn, { deferrable: true, isolationLevel: "SERIALIZABLE" }))
        .toThrow(/deferrable requires readOnly/);
    });
  });

  describe("validate()", () => {
    it("passes when schema matches the database", async () => {
      Entity("val_users2", {
        id: "integer primary key autoincrement",
        name: "text not null",
      });
      const db = new Db(freshDriver());
      await db.migrate();
      await expect(db.validate()).resolves.not.toThrow();
      await db.close();
    });

    it("throws when table does not exist", async () => {
      Entity("val_ghost2", { id: "integer primary key" });
      const db = new Db(freshDriver());
      await expect(db.validate()).rejects.toThrow("does not exist");
      await db.close();
    });

    it("throws when a column is missing from the database", async () => {
      const driver = freshDriver();
      await driver.execute(`CREATE TABLE "val_partial2" ("id" integer primary key)`);
      Entity("val_partial2", {
        id: "integer primary key",
        name: "text",
      });
      const db = new Db(driver);
      await expect(db.validate()).rejects.toThrow('column "name"');
      await db.close();
    });
  });
});
