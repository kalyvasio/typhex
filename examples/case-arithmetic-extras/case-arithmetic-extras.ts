/**
 * CASE/arithmetic extras: IS NULL, computed SELECT columns, ORDER BY expressions,
 * and closure-variable capture in `.select()` (runtime mode).
 *
 * From examples/: npm run case-arithmetic-extras
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
await Order.query().insert({
  category: "a",
  price: 20,
  qty: 6,
  active: 1,
  deletedAt: "2025-01-01",
});
await Order.query().insert({ category: "a", price: 15, qty: 4, active: 1, deletedAt: null });
await Order.query().insert({ category: "b", price: 5, qty: 1, active: 1, deletedAt: null });
await Order.query().insert({ category: "b", price: 15, qty: 9, active: 0, deletedAt: null });

const liveCount = await Order.query()
  .where((o) => o.deletedAt === null)
  .count();
console.log("Live (not deleted) order count:", liveCount); // 4

const deletedCount = await Order.query()
  .where((o) => o.deletedAt !== null)
  .count();
console.log("Deleted order count:", deletedCount); // 1

const lineItems = await Order.query()
  .select((o) => ({
    id: o.id,
    revenue: o.price * o.qty,
    bucket: o.qty < 5 ? "small" : "large",
  }))
  .orderBy("id")
  .toArray();
console.log("Line items with computed revenue + bucket:", lineItems);

const cents = await Order.query()
  .select((o) => o.price * 100)
  .toArray();
console.log("Prices in cents (aliased as 'expr'):", cents);

const sortedByQty = await Order.query()
  .select((o) => ({ id: o.id, qty: o.qty }))
  .orderBy((o) => (o.qty < 5 ? 1 : 0))
  .toArray();
console.log("Orders sorted large-first by qty bucket:", sortedByQty);

const cutoff = 5;
const buckets = await Order.query()
  .select(
    (o) => ({
      category: o.category,
      smalls: sum(o.qty < cutoff ? 1 : 0),
    }),
    { cutoff },
  )
  .groupBy("category")
  .orderBy("category")
  .toArray();
console.log(`Counts of orders with qty < ${cutoff}, per category:`, buckets);

await db.close();
