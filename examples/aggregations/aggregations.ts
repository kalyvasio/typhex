/**
 * Aggregations example: count/sum/avg/min/max, groupBy, and having — runtime (no transformer).
 * The acorn parser reads arrow function source text at runtime, so no build step is required.
 * Run: npx tsx examples/aggregations/aggregations.ts  (from project root)
 *   or: npm run aggregations  (from examples/)
 */

import { Db, Entity, createSqliteDriver, count, sum, avg, min, max, distinct } from "../../src/index.js";
import { groupConcat } from "../../src/sqlite.js";

const Order = Entity("orders", {
  id: "integer primary key autoincrement",
  category: "text not null",
  status: "text not null",
  price: "integer not null",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

await Order.query().insert({ category: "electronics", status: "shipped", price: 299 });
await Order.query().insert({ category: "electronics", status: "shipped", price: 199 });
await Order.query().insert({ category: "electronics", status: "pending", price: 399 });
await Order.query().insert({ category: "clothing",    status: "shipped", price: 49  });
await Order.query().insert({ category: "clothing",    status: "pending", price: 79  });
await Order.query().insert({ category: "clothing",    status: "pending", price: 59  });
await Order.query().insert({ category: "books",       status: "shipped", price: 19  });

// --- Shorthand select forms (runtime-parsed arrows) ---

// select * — p => p
const all = await Order.query().select((o) => o).toArray();
console.log("Select * (all columns):", all.length, "rows");

// single column — p => p.category
const categories = await Order.query().select((o) => o.category).toArray();
console.log("Single column (category):", categories);

// single aggregate — p => count(p.id)
const total = await Order.query().select((o) => count(o.id)).toArray();
console.log("Total order count:", total);

// --- Object-form selects with aggregates ---

// { category: p.category, revenue: sum(p.price) }
const revenueByCategory = await Order.query()
  .select((o) => ({ category: o.category, revenue: sum(o.price) }))
  .groupBy((o) => o.category)
  .toArray();
console.log("Revenue by category:", revenueByCategory);

// multiple aggregates in one select
const stats = await Order.query()
  .select((o) => ({ total: count(o.id), minPrice: min(o.price), maxPrice: max(o.price), avgPrice: avg(o.price) }))
  .toArray();
console.log("Order stats:", stats);

// --- groupBy with string args ---

const byStatus = await Order.query()
  .select((o) => ({ status: o.status, cnt: count(o.id) }))
  .groupBy("status")
  .toArray();
console.log("Count by status:", byStatus);

// groupBy multiple columns
const byCategoryAndStatus = await Order.query()
  .select((o) => ({ category: o.category, status: o.status, cnt: count(o.id) }))
  .groupBy("category", "status")
  .toArray();
console.log("Count by category+status:", byCategoryAndStatus);

// --- having with arrow (runtime-parsed) ---

// only categories with more than 1 order
const busyCategories = await Order.query()
  .select((o) => ({ category: o.category, cnt: count(o.id) }))
  .groupBy((o) => o.category)
  .having((o) => count(o.id) > 1)
  .toArray();
console.log("Categories with > 1 order:", busyCategories);

// having with a closure variable
const minRevenue = 200;
const highRevenueCategories = await Order.query()
  .select((o) => ({ category: o.category, revenue: sum(o.price) }))
  .groupBy((o) => o.category)
  .having((o) => sum(o.price) >= minRevenue, { minRevenue })
  .toArray();
console.log(`Categories with revenue >= ${minRevenue}:`, highRevenueCategories);

// --- Combining where + groupBy + having ---

const shippedStats = await Order.query()
  .where((o) => o.status === "shipped")
  .select((o) => ({ category: o.category, cnt: count(o.id), total: sum(o.price) }))
  .groupBy((o) => o.category)
  .having((o) => count(o.id) > 0)
  .orderBy(o=> o.category, "asc")
  .toArray();
console.log("Shipped orders by category:", shippedStats);

// --- distinct() wrapper ---

// count unique categories across all orders
const uniqueCategories = await Order.query()
  .select((o) => ({ uniqueCategories: count(distinct(o.category)) }))
  .toArray();
console.log("Unique category count:", uniqueCategories);

// sum distinct prices (deduplicated)
const distinctRevenue = await Order.query()
  .select((o) => ({ revenue: sum(distinct(o.price)) }))
  .toArray();
console.log("Revenue from distinct prices:", distinctRevenue);

// --- Positional GROUP BY (GROUP BY 1, 2) ---

// Group by the 1st column in the SELECT list
const positionalByFirst = await Order.query()
  .select((o) => ({ category: o.category, cnt: count(o.id) }))
  .groupBy(1)
  .toArray();
console.log("Positional GROUP BY 1 (category):", positionalByFirst);

// Group by multiple positional references
const positionalMulti = await Order.query()
  .select((o) => ({ category: o.category, status: o.status, cnt: count(o.id) }))
  .groupBy([1, 2])
  .toArray();
console.log("Positional GROUP BY 1, 2 (category + status):", positionalMulti);

// Numeric string also treated as positional
const positionalString = await Order.query()
  .select((o) => ({ category: o.category, cnt: count(o.id) }))
  .groupBy("1")
  .toArray();
console.log("Positional GROUP BY via string '1':", positionalString);

// --- groupConcat / STRING_AGG ---

// concatenate all category names into one string
const categoryList = await Order.query()
  .select((o) => ({ categories: groupConcat(o.category, " | ") }))
  .toArray();
console.log("All categories concatenated:", categoryList);

// groupConcat per status
const categoriesByStatus = await Order.query()
  .select((o) => ({ status: o.status, categories: groupConcat(o.category, ", ") }))
  .groupBy((o) => o.status)
  .toArray();
console.log("Categories by status:", categoriesByStatus);

await db.close();
console.log("Done.");
