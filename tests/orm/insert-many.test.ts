/**
 * Integration tests for insertMany and onConflict.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db } from "../../src/orm/db.js";
import { Entity } from "../../src/index.js";
import { InsertBuilder } from "../../src/orm/query-builder.js";
import { clearRegistry, setDefaultDb } from "../../src/entity/global-driver.js";
import { freshDriver } from "../helpers.js";

describe("insertMany", () => {
  let db: Db;

  beforeEach(() => {
    clearRegistry();
  });
  afterEach(async () => {
    await db?.close();
    setDefaultDb(null);
  });

  it("inserts multiple rows in one statement", async () => {
    const Product = Entity("im_products", {
      id: "integer primary key autoincrement",
      name: "text not null",
      price: "integer not null",
    });
    db = new Db(freshDriver());
    await db.migrate();

    await Product.query().insertMany([
      { name: "Widget", price: 10 },
      { name: "Gadget", price: 20 },
      { name: "Doohickey", price: 30 },
    ]);

    expect(await Product.query().count()).toBe(3);
  });

  it("returns empty array immediately for empty input without hitting the DB", async () => {
    const Product = Entity("im_products_empty", {
      id: "integer primary key autoincrement",
      name: "text not null",
      price: "integer not null",
    });
    db = new Db(freshDriver());
    await db.migrate();

    const result = await Product.query().insertMany([]);
    expect(result).toEqual([]);
    expect(await Product.query().count()).toBe(0);
  });

  it("rows with absent optional columns default to null", async () => {
    const Item = Entity("im_items_optional", {
      id: "integer primary key autoincrement",
      name: "text not null",
      note: "text",
    });
    db = new Db(freshDriver());
    await db.migrate();

    await Item.query().insertMany([{ name: "Alpha", note: "has note" }, { name: "Beta" }]);

    expect(await Item.query().count()).toBe(2);
    const beta = (await Item.query()
      .where((i: any) => i.name === "Beta")
      .first()) as any;
    expect(beta.note).toBeNull();
  });

  it("all rows are retrievable after batch insert", async () => {
    const Tag = Entity("im_tags_basic", {
      id: "integer primary key autoincrement",
      slug: "text not null",
    });
    db = new Db(freshDriver());
    await db.migrate();

    await Tag.query().insertMany([
      { slug: "typescript" },
      { slug: "javascript" },
      { slug: "rust" },
    ]);

    const all = (await Tag.query().orderBy("slug").toArray()) as any[];
    expect(all.map((t) => t.slug)).toEqual(["javascript", "rust", "typescript"]);
  });
});

describe("onConflict", () => {
  let db: Db;

  beforeEach(() => {
    clearRegistry();
  });
  afterEach(async () => {
    await db?.close();
    setDefaultDb(null);
  });

  it("doNothing() skips conflicting rows and leaves originals unchanged", async () => {
    const Tag = Entity("oc_tags_nothing", {
      id: "integer primary key autoincrement",
      slug: "text not null unique",
      label: "text not null",
    });
    db = new Db(freshDriver());
    await db.migrate();

    await Tag.query().insert({ slug: "ts", label: "TypeScript" });

    // Insert same slug again — should be skipped
    await Tag.query().insert({ slug: "ts", label: "UPDATED" }).onConflict(["slug"]).doNothing();

    expect(await Tag.query().count()).toBe(1);
    const row = (await Tag.query().first()) as any;
    expect(row.label).toBe("TypeScript");
  });

  it("doUpdate() updates all non-conflict columns on clash", async () => {
    const Tag = Entity("oc_tags_update", {
      id: "integer primary key autoincrement",
      slug: "text not null unique",
      label: "text not null",
    });
    db = new Db(freshDriver());
    await db.migrate();

    await Tag.query().insert({ slug: "js", label: "JavaScript" });

    await Tag.query().insert({ slug: "js", label: "JS (updated)" }).onConflict(["slug"]).doUpdate();

    expect(await Tag.query().count()).toBe(1);
    const row = (await Tag.query().first()) as any;
    expect(row.label).toBe("JS (updated)");
  });

  it("doUpdate(columns) updates only the specified columns", async () => {
    const Product = Entity("oc_products_cols", {
      id: "integer primary key autoincrement",
      sku: "text not null unique",
      name: "text not null",
      price: "integer not null",
    });
    db = new Db(freshDriver());
    await db.migrate();

    await Product.query().insert({ sku: "W1", name: "Widget v1", price: 10 });

    // Only update price, not name
    await Product.query()
      .insert({ sku: "W1", name: "Widget v999", price: 99 })
      .onConflict(["sku"])
      .doUpdate(["price"]);

    const row = (await Product.query().first()) as any;
    expect(row.name).toBe("Widget v1"); // unchanged
    expect(row.price).toBe(99); // updated
  });

  it("doNothing() with insertMany skips all conflicting rows", async () => {
    const Tag = Entity("oc_tags_many_nothing", {
      id: "integer primary key autoincrement",
      slug: "text not null unique",
      label: "text not null",
    });
    db = new Db(freshDriver());
    await db.migrate();

    await Tag.query().insert({ slug: "a", label: "original-a" });
    await Tag.query().insert({ slug: "b", label: "original-b" });

    await Tag.query()
      .insertMany([
        { slug: "a", label: "conflict-a" }, // skipped
        { slug: "c", label: "new-c" }, // inserted
      ])
      .onConflict(["slug"])
      .doNothing();

    expect(await Tag.query().count()).toBe(3);
    const a = (await Tag.query()
      .where((t: any) => t.slug === "a")
      .first()) as any;
    expect(a.label).toBe("original-a");
  });

  it("doUpdate() with insertMany upserts all rows", async () => {
    const Tag = Entity("oc_tags_many_update", {
      id: "integer primary key autoincrement",
      slug: "text not null unique",
      label: "text not null",
    });
    db = new Db(freshDriver());
    await db.migrate();

    await Tag.query().insert({ slug: "a", label: "original-a" });

    await Tag.query()
      .insertMany([
        { slug: "a", label: "updated-a" }, // conflict → update
        { slug: "b", label: "new-b" }, // no conflict → insert
      ])
      .onConflict(["slug"])
      .doUpdate();

    expect(await Tag.query().count()).toBe(2);
    const a = (await Tag.query()
      .where((t: any) => t.slug === "a")
      .first()) as any;
    expect(a.label).toBe("updated-a");
  });

  it("InsertBuilder is exported from the public API", () => {
    expect(InsertBuilder).toBeDefined();
  });
});
