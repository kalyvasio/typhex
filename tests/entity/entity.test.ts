import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Entity } from "../../src/entity/entity.js";
import { Db } from "../../src/orm/db.js";
import { createSqliteDriver } from "../../src/driver/sqlite.js";
import { setDefaultDriver, clearRegistry } from "../../src/entity/global-driver.js";
import type { Driver } from "../../src/driver/types.js";
import { QueryBuilder } from "../../src/orm/query-builder.js";

const userSchema = {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
} as const;

function freshDriver(): Driver {
  return createSqliteDriver({ path: ":memory:" });
}

describe("Entity()", () => {
  let db: Db;

  beforeEach(() => {
    clearRegistry();
    db = new Db(freshDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  describe("factory", () => {
    it("returns a constructable class with table metadata", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      expect(User.table._table).toBe("users");
      expect(User.table._schema).toEqual(userSchema);
    });

    it("constructor assigns column values from data", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const u = new User({ name: "Alice", age: 30 });
      expect((u as any).name).toBe("Alice");
      expect((u as any).age).toBe(30);
    });

    it("marks instances without pk as _isNew", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const u = new User({ name: "Alice" });
      expect(u._isNew).toBe(true);
    });

    it("marks instances with pk as not _isNew", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const u = new User({ id: 1, name: "Alice" } as any);
      expect(u._isNew).toBe(false);
    });
  });

  describe("create()", () => {
    it("inserts a row and returns a hydrated instance", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const u = await User.create({ name: "Alice", age: 30 });
      expect((u as any).id).toBe(1);
      expect((u as any).name).toBe("Alice");
      expect(u._isNew).toBe(false);
    });

    it("auto-increments ids", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const a = await User.create({ name: "Alice", age: 30 });
      const b = await User.create({ name: "Bob", age: 25 });
      expect((a as any).id).toBe(1);
      expect((b as any).id).toBe(2);
    });
  });

  describe("query()", () => {
    it("returns a QueryBuilder", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      expect(User.query()).toBeInstanceOf(QueryBuilder);
    });

    it("toArray returns all rows as entity instances", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      await User.create({ name: "Alice", age: 30 });
      await User.create({ name: "Bob", age: 25 });
      const all = await User.query().toArray();
      expect(all).toHaveLength(2);
      expect(all[0]._isNew).toBe(false);
      expect((all[0] as any).name).toBe("Alice");
    });

    it("where filters rows", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      await User.create({ name: "Alice", age: 30 });
      await User.create({ name: "Bob", age: 20 });
      const adults = await User.query().where((u) => u.age > 25).toArray();
      expect(adults).toHaveLength(1);
      expect((adults[0] as any).name).toBe("Alice");
    });

    it("count returns number of matching rows", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      await User.create({ name: "Alice", age: 30 });
      await User.create({ name: "Bob", age: 20 });
      expect(await User.query().count()).toBe(2);
      expect(await User.query().where((u) => u.age > 25).count()).toBe(1);
    });

    it("first returns single row or undefined", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      expect(await User.query().first()).toBeUndefined();
      await User.create({ name: "Alice", age: 30 });
      const first = await User.query().first();
      expect(first).toBeDefined();
      expect((first as any).name).toBe("Alice");
    });

    it("orderBy sorts results", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      await User.create({ name: "Charlie", age: 35 });
      await User.create({ name: "Alice", age: 30 });
      await User.create({ name: "Bob", age: 25 });
      const sorted = await User.query().orderBy("name", "asc").toArray();
      expect((sorted[0] as any).name).toBe("Alice");
      expect((sorted[2] as any).name).toBe("Charlie");
    });

    it("limit restricts result count", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      await User.create({ name: "Alice", age: 30 });
      await User.create({ name: "Bob", age: 25 });
      await User.create({ name: "Carol", age: 28 });
      const limited = await User.query().limit(2).toArray();
      expect(limited).toHaveLength(2);
    });
  });

  describe("findById()", () => {
    it("returns instance when found", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      await User.create({ name: "Alice", age: 30 });
      const found = await User.findById(1);
      expect(found).not.toBeNull();
      expect((found as any).name).toBe("Alice");
      expect(found!._isNew).toBe(false);
    });

    it("returns null when not found", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const found = await User.findById(999);
      expect(found).toBeNull();
    });
  });

  describe("save()", () => {
    it("inserts when _isNew", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const u = new User({ name: "Alice", age: 30 });
      expect(u._isNew).toBe(true);
      await u.save();
      expect(u._isNew).toBe(false);
      expect((u as any).id).toBe(1);
      expect(await User.query().count()).toBe(1);
    });

    it("updates when dirty fields exist", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const u = await User.create({ name: "Alice", age: 30 });
      (u as any).name = "Alice Updated";
      u._dirty = new Set(["name"]);
      await u.save();
      const reloaded = await User.findById((u as any).id);
      expect((reloaded as any).name).toBe("Alice Updated");
    });

    it("returns this for chaining", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const u = new User({ name: "Alice", age: 30 });
      const result = await u.save();
      expect(result).toBe(u);
    });
  });

  describe("delete()", () => {
    it("removes the row from the database", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      const u = await User.create({ name: "Alice", age: 30 });
      expect(await User.query().count()).toBe(1);
      await u.delete();
      expect(await User.query().count()).toBe(0);
    });
  });

  describe("query-builder update/delete", () => {
    it("update modifies matching rows", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      await User.create({ name: "Alice", age: 30 });
      await User.create({ name: "Bob", age: 25 });
      const changed = await User.query().where((u) => u.name === "Bob").update({ age: 26 });
      expect(changed).toBe(1);
      const bob = await User.query().where((u) => u.name === "Bob").first();
      expect((bob as any).age).toBe(26);
    });

    it("delete removes matching rows", async () => {
      const User = Entity("users", userSchema);
      await db.migrate();
      await User.create({ name: "Alice", age: 30 });
      await User.create({ name: "Bob", age: 25 });
      const deleted = await User.query().where((u) => u.name === "Bob").delete();
      expect(deleted).toBe(1);
      expect(await User.query().count()).toBe(1);
    });
  });
});

describe("Entity subclassing", () => {
  let db: Db;

  beforeEach(() => {
    clearRegistry();
    db = new Db(freshDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  it("subclass instances have custom getters", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    class UserEntity extends Base {
      get displayName() {
        return (this as any).name ?? "Anonymous";
      }
    }

    const u = await UserEntity.create({ name: "Alice", age: 30 });
    expect((u as any).displayName).toBe("Alice");
  });

  it("query() hydrates rows as subclass instances", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    class UserEntity extends Base {
      get upper() {
        return ((this as any).name as string).toUpperCase();
      }
    }

    await UserEntity.create({ name: "Alice", age: 30 });
    const results = await UserEntity.query().toArray();
    expect(results).toHaveLength(1);
    expect((results[0] as any).upper).toBe("ALICE");
  });

  it("findById hydrates as subclass", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    class UserEntity extends Base {
      get tag() { return `user:${(this as any).id}`; }
    }

    await UserEntity.create({ name: "Alice", age: 30 });
    const found = await UserEntity.findById(1);
    expect((found as any).tag).toBe("user:1");
  });
});

describe("lifecycle hooks", () => {
  let db: Db;

  beforeEach(() => {
    clearRegistry();
    db = new Db(freshDriver());
  });

  afterEach(async () => {
    await db.close();
  });

  it("beforeSave is called on save", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    let hookCalled = false;
    class UserEntity extends Base {
      beforeSave() { hookCalled = true; }
    }

    const u = new UserEntity({ name: "Alice", age: 30 });
    await u.save();
    expect(hookCalled).toBe(true);
  });

  it("afterSave is called after save", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    let hookCalled = false;
    class UserEntity extends Base {
      afterSave() { hookCalled = true; }
    }

    const u = new UserEntity({ name: "Alice", age: 30 });
    await u.save();
    expect(hookCalled).toBe(true);
  });

  it("beforeCreate and afterCreate are called on insert", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    const calls: string[] = [];
    class UserEntity extends Base {
      beforeCreate() { calls.push("beforeCreate"); }
      afterCreate() { calls.push("afterCreate"); }
    }

    const u = new UserEntity({ name: "Alice", age: 30 });
    await u.save();
    expect(calls).toEqual(["beforeCreate", "afterCreate"]);
  });

  it("beforeUpdate and afterUpdate are called on update", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    const calls: string[] = [];
    class UserEntity extends Base {
      beforeUpdate() { calls.push("beforeUpdate"); }
      afterUpdate() { calls.push("afterUpdate"); }
    }

    const u = await UserEntity.create({ name: "Alice", age: 30 });
    (u as any).name = "Alice Updated";
    u._dirty = new Set(["name"]);
    await u.save();
    expect(calls).toEqual(["beforeUpdate", "afterUpdate"]);
  });

  it("beforeDelete and afterDelete are called on delete", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    const calls: string[] = [];
    class UserEntity extends Base {
      beforeDelete() { calls.push("beforeDelete"); }
      afterDelete() { calls.push("afterDelete"); }
    }

    const u = await UserEntity.create({ name: "Alice", age: 30 });
    await u.delete();
    expect(calls).toEqual(["beforeDelete", "afterDelete"]);
  });

  it("afterLoad is called by findById", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    let hookCalled = false;
    class UserEntity extends Base {
      afterLoad() { hookCalled = true; }
    }

    await UserEntity.create({ name: "Alice", age: 30 });
    await UserEntity.findById(1);
    expect(hookCalled).toBe(true);
  });

  it("afterLoad is called for query hydration", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    let calls = 0;
    class UserEntity extends Base {
      afterLoad() { calls += 1; }
    }

    await UserEntity.create({ name: "Alice", age: 30 });
    await UserEntity.create({ name: "Bob", age: 20 });
    expect(calls).toBe(2);
    const rows = await UserEntity.query().toArray();
    expect(rows).toHaveLength(2);
    expect(calls).toBe(4);
  });

  it("findById awaits async afterLoad", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    let loadedName = "";
    class UserEntity extends Base {
      async afterLoad() {
        await Promise.resolve();
        loadedName = (this as any).name;
      }
    }

    await UserEntity.create({ name: "Alice", age: 30 });
    const found = await UserEntity.findById(1);
    expect(found).not.toBeNull();
    expect(loadedName).toBe("Alice");
  });

  it("query hydration awaits async afterLoad", async () => {
    const Base = Entity("users", userSchema);
    await db.migrate();

    const loaded: string[] = [];
    class UserEntity extends Base {
      async afterLoad() {
        await Promise.resolve();
        loaded.push((this as any).name);
      }
    }

    await UserEntity.create({ name: "Alice", age: 30 });
    await UserEntity.create({ name: "Bob", age: 20 });
    expect(loaded).toEqual(["Alice", "Bob"]);
    const rows = await UserEntity.query().toArray();
    expect(rows).toHaveLength(2);
    expect(loaded).toEqual(["Alice", "Bob", "Alice", "Bob"]);
  });
});

describe("driver resolution", () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    setDefaultDriver(null);
  });

  it("throws when no driver is set", () => {
    const User = Entity("things", { id: "integer primary key" });
    expect(() => User.query()).toThrow("no driver");
  });

  it("useDriver sets a per-entity driver", async () => {
    const driver = freshDriver();
    const User = Entity("users2", userSchema);
    User.useDriver(driver);
    driver.run(`CREATE TABLE "users2" ("id" integer primary key autoincrement, "name" text not null, "age" integer)`);
    await User.create({ name: "Test", age: 1 });
    expect(await User.query().count()).toBe(1);
    driver.close();
  });

  it("per-query driver override takes precedence", async () => {
    const mainDriver = freshDriver();
    const altDriver = freshDriver();
    setDefaultDriver(mainDriver);

    const User = Entity("users3", userSchema);
    mainDriver.run(`CREATE TABLE "users3" ("id" integer primary key autoincrement, "name" text not null, "age" integer)`);
    altDriver.run(`CREATE TABLE "users3" ("id" integer primary key autoincrement, "name" text not null, "age" integer)`);

    await User.create({ name: "MainDB" });
    await User.create({ name: "AltDB" }, altDriver);

    expect(await User.query().count()).toBe(1);
    expect(await User.query(altDriver).count()).toBe(1);
    expect((await User.query().first() as any).name).toBe("MainDB");
    expect((await User.query(altDriver).first() as any).name).toBe("AltDB");

    mainDriver.close();
    altDriver.close();
  });
});
