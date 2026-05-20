/**
 * CTE (WITH clause) example: withCte / fromCte — runtime (no transformer).
 * Run: npx tsx examples/cte/cte.ts  (from project root)
 *   or: npm run cte  (from examples/)
 */

import { Db, Entity, createSqliteDriver } from "../../src/index.js";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer not null",
  country: "text not null",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

await User.query().insert({ name: "Alice", age: 28, country: "US" });
await User.query().insert({ name: "Bob", age: 35, country: "US" });
await User.query().insert({ name: "Carol", age: 19, country: "UK" });
await User.query().insert({ name: "Dan", age: 67, country: "UK" });
await User.query().insert({ name: "Eve", age: 42, country: "FR" });

// --- 1. Basic CTE: adults, then working-age within that set ---

{
  const adults = User.query().where((u) => u.age >= 18);
  const workingAge = await User.query()
    .withCte("adults", adults)
    .fromCte("adults")
    .where((u) => u.age < 65)
    .toArray();

  console.log(
    "1. Working-age adults:",
    workingAge.map((u) => `${u.name} (${u.age})`),
  );
}

// --- 2. CTE + count(): aggregate over a CTE result ---

{
  const usOnly = User.query().where((u) => u.country === "US");
  const total = await User.query().withCte("us_users", usOnly).fromCte("us_users").count();
  console.log("2. Total US users (via CTE count):", total);
}

// --- 3. Nested CTE guard ---

{
  const base = User.query().where((u) => u.id > 0);
  const inner = User.query().withCte("inner_cte", base);
  try {
    User.query().withCte("outer", inner);
  } catch (e) {
    console.log("3. Nested CTE rejected:", (e as Error).message);
  }
}

await db.close();
console.log("Done.");
