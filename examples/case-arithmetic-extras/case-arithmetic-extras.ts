/**
 * CASE/arithmetic extras: IS NULL, computed SELECT columns, ORDER BY expressions,
 * and closure-variable capture in `.select()` — runtime mode (no transformer).
 *
 * Run: npx tsx examples/case-arithmetic-extras/case-arithmetic-extras.ts
 *   or: npm run case-arithmetic-extras  (from examples/)
 */

import { Db, Entity, createSqliteDriver, sum } from "../../src/index.js";

const Order = Entity("orders", {
  id: "integer primary key autoincrement",
  category: "text not null",
  price: "integer not null",
  qty: "integer not null",
  active: "integer not null",
  deletedAt: "text",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

await Order.query().insert({ category: "a", price: 10, qty: 2, active: 1, deletedAt: null });
await Order.query().insert({ category: "a", price: 20, qty: 6, active: 1, deletedAt: "2025-01-01" });
await Order.query().insert({ category: "a", price: 15, qty: 4, active: 1, deletedAt: null });
await Order.query().insert({ category: "b", price:  5, qty: 1, active: 1, deletedAt: null });
await Order.query().insert({ category: "b", price: 15, qty: 9, active: 0, deletedAt: null });

// --- 1. IS NULL / IS NOT NULL ---------------------------------------------
// `=== null` rewrites to SQL `IS NULL` (matching JS semantics).

const liveCount = await Order.query()
  .where((o) => o.deletedAt === null)
  .count();
console.log("Live (not deleted) order count:", liveCount); // 4

const deletedCount = await Order.query()
  .where((o) => o.deletedAt !== null)
  .count();
console.log("Deleted order count:", deletedCount); // 1

// --- 2. Computed SELECT columns -------------------------------------------
// Arithmetic and ternary expressions in object-literal SELECTs are emitted
// as inline SQL — no parameters needed.

const lineItems = await Order.query()
  .select((o) => ({
    id: o.id,
    revenue: o.price * o.qty,
    bucket: o.qty < 5 ? "small" : "large",
  }))
  .orderBy("id")
  .toArray() as unknown as Array<{ id: number; revenue: number; bucket: string }>;
console.log("Line items with computed revenue + bucket:", lineItems);

// Single-expression shorthand: `(o) => o.price * 100` aliased to "expr".
const cents = await Order.query()
  .select((o) => o.price * 100)
  .toArray();
console.log("Prices in cents (aliased as 'expr'):", cents);

// --- 3. ORDER BY computed expressions -------------------------------------
// Sort by a derived value — classic "pin large orders to top" pattern.

const sortedByQty = await Order.query()
  .select((o) => ({ id: o.id, qty: o.qty }))
  .orderBy((o) => (o.qty < 5 ? 1 : 0)) // large first, small after
  .toArray() as unknown as Array<{ id: number; qty: number }>;
console.log("Orders sorted large-first by qty bucket:", sortedByQty);

// --- 4. Closure-variable capture in .select() -----------------------------
// `cutoff` is captured in the second arg, then substituted into the IR
// at compile time — `< cutoff` becomes `< 5` in the emitted SQL.

const cutoff = 5;
const buckets = await Order.query()
  .select((o) => ({
    category: o.category,
    smalls: sum(o.qty < cutoff ? 1 : 0),
  }), { cutoff })
  .groupBy("category")
  .orderBy("category")
  .toArray() as unknown as Array<{ category: string; smalls: number }>;
console.log(`Counts of orders with qty < ${cutoff}, per category:`, buckets);

await db.close();
