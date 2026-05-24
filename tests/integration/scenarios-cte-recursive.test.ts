/**
 * Integration scenarios for Phase 2 CTE features: unionAll, withRecursiveCte,
 * and entity-table joins (innerJoin(entity, on)).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db, Entity } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { freshDb } from "../helpers.js";

describe("CTE Phase 2 (SQLite)", () => {
  const User = Entity("users", {
    id: "integer primary key autoincrement",
    name: "text not null",
    age: "integer not null",
    country: "text not null",
  });

  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(User);
    db = freshDb();
    await db.migrate();
    await User.query().insert({ name: "Alice", age: 28, country: "US" });
    await User.query().insert({ name: "Bob", age: 35, country: "US" });
    await User.query().insert({ name: "Carol", age: 19, country: "UK" });
    await User.query().insert({ name: "Dan", age: 67, country: "UK" });
  });

  afterEach(async () => {
    await db.close();
  });

  it("unionAll merges two disjoint row sets", async () => {
    const young = User.query().where((u) => u.age < 25);
    const senior = User.query().where((u) => u.age >= 65);
    const rows = await young.unionAll(senior).toArray();
    expect(rows.map((r) => r.name).sort()).toEqual(["Carol", "Dan"]);
  });

  it("unionAll can be wrapped in a CTE and ordered in the outer query", async () => {
    const young = User.query().where((u) => u.age < 25);
    const senior = User.query().where((u) => u.age >= 65);
    const rows = await User.query()
      .withCte("ends", young.unionAll(senior))
      .from("ends")
      .orderBy("name", "asc")
      .toArray();
    expect(rows.map((r) => r.name)).toEqual(["Carol", "Dan"]);
  });

  it("withRecursiveCte executes anchor rows when the recursive step adds nothing", async () => {
    const anchor = User.query().where((u) => u.age >= 65);
    const recursive = User.query().from("seniors").where((u) => u.age >= 100);
    const body = anchor.unionAll(recursive);
    const rows = await User.query().withRecursiveCte("seniors", body).from("seniors").toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Dan");
  });

  it("withRecursiveCte self-references the CTE name in the recursive branch", async () => {
    const anchor = User.query().where((u) => u.age >= 21 && u.age < 65);
    const recursive = User.query().from("adults").where((u) => u.age >= 99);
    const body = anchor.unionAll(recursive);
    const rows = await User.query().withRecursiveCte("adults", body).from("adults").toArray();
    expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "Bob"]);
  });

  it("innerJoin(entity, on) joins the entity table with a custom ON predicate", async () => {
    const rows = await User.query()
      .innerJoin(User, (peer, u) => peer.country === u.country && peer.id !== u.id)
      .where((u) => u.country === "US")
      .toArray();
    expect(rows.map((r) => r.name).sort()).toEqual(["Alice", "Bob"]);
  });
});
