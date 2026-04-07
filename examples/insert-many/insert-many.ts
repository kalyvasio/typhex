/**
 * insertMany + onConflict example.
 *
 * Demonstrates:
 *   - insertMany: bulk-insert rows in a single SQL statement
 *   - onConflict().doNothing(): skip rows that violate a UNIQUE constraint
 *   - onConflict().doUpdate(): update all non-conflict columns on clash
 *   - onConflict().doUpdate(cols): update only specified columns
 *
 * Run: npx tsx examples/insert-many/insert-many.ts  (from project root)
 *   or: npm run insert-many  (from examples/)
 */

import { Db, Entity, createSqliteDriver } from "../../src/index.js";

// A product catalogue with a unique SKU.
const Product = Entity("products", {
  id: "integer primary key autoincrement",
  sku: "text not null unique",
  name: "text not null",
  price: "integer not null",   // cents
  stock: "integer not null",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

// ── insertMany ────────────────────────────────────────────────────────────────
// Bulk-insert a catalogue in one round-trip.
await Product.query().insertMany([
  { sku: "W-001", name: "Widget",    price: 999,  stock: 100 },
  { sku: "G-001", name: "Gadget",    price: 1499, stock: 50  },
  { sku: "D-001", name: "Doohickey", price: 249,  stock: 200 },
]);

console.log("After initial insertMany:", await Product.query().count(), "products");
// → 3

// ── onConflict().doNothing() ──────────────────────────────────────────────────
// Re-import the same catalogue but skip duplicates silently.
await Product.query()
  .insertMany([
    { sku: "W-001", name: "Widget UPDATED", price: 888, stock: 999 }, // skipped
    { sku: "T-001", name: "Thingamajig",    price: 599, stock: 75  }, // inserted
  ])
  .onConflict(["sku"])
  .doNothing();

console.log("\nAfter doNothing insertMany:", await Product.query().count(), "products");
// → 4

const widget = await Product.query()
  .where((p: any) => p.sku === "W-001")
  .first() as any;
console.log("Widget is unchanged — name:", widget.name, "| price:", widget.price);
// → Widget | 999

// ── onConflict().doUpdate() ───────────────────────────────────────────────────
// Update ALL non-conflict columns on clash.
await Product.query()
  .insert({ sku: "W-001", name: "Widget v2", price: 1099, stock: 80 })
  .onConflict(["sku"])
  .doUpdate();

const widgetV2 = await Product.query()
  .where((p: any) => p.sku === "W-001")
  .first() as any;
console.log("\nWidget after doUpdate — name:", widgetV2.name, "| price:", widgetV2.price);
// → Widget v2 | 1099

// ── onConflict().doUpdate(cols) ───────────────────────────────────────────────
// Update only specified columns (keep the name, refresh the price).
await Product.query()
  .insert({ sku: "G-001", name: "Gadget RENAMED", price: 1799, stock: 0 })
  .onConflict(["sku"])
  .doUpdate(["price"]);

const gadget = await Product.query()
  .where((p: any) => p.sku === "G-001")
  .first() as any;
console.log("\nGadget after partial doUpdate — name:", gadget.name, "| price:", gadget.price);
// name is unchanged ("Gadget"), only price was updated (1799)

// ── onConflict + insertMany together ─────────────────────────────────────────
// Bulk-update a price list: new SKUs are inserted, existing ones get price updated.
await Product.query()
  .insertMany([
    { sku: "W-001", name: "irrelevant", price: 500,  stock: 0  }, // price updated to 500
    { sku: "Z-001", name: "Zapper",     price: 3999, stock: 10 }, // new product
  ])
  .onConflict(["sku"])
  .doUpdate(["price"]);

const widgetFinal = await Product.query()
  .where((p: any) => p.sku === "W-001")
  .first() as any;
console.log("\nWidget price after bulk price update:", widgetFinal.price);
// → 500

console.log("Total products:", await Product.query().count());
// → 5 (W-001, G-001, D-001, T-001, Z-001)

await db.close();
console.log("\nDone.");
