/**
 * CTE (WITH clause) example: withCte / from — runtime (no transformer).
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
    .from("adults")
    .where((u) => u.age < 65)
    .toArray();
  // SQL:
  // WITH "adults" AS (
  //   SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  //   FROM "users" AS "t0"
  //   WHERE ("t0"."age" >= ?)
  // )
  // SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  // FROM "adults" AS "t0"
  // WHERE ("t0"."age" < ?)
  // params: [18, 65]

  console.log(
    "1. Working-age adults:",
    workingAge.map((u) => `${u.name} (${u.age})`),
  );
}

// --- 2. CTE + count(): aggregate over a CTE result ---

{
  const usOnly = User.query().where((u) => u.country === "US");
  const total = await User.query().withCte("us_users", usOnly).from("us_users").count();
  // SQL:
  // SELECT COUNT(*) AS c FROM (
  //   WITH "us_users" AS (
  //     SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  //     FROM "users" AS "t0"
  //     WHERE ("t0"."country" = ?)
  //   )
  //   SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  //   FROM "us_users" AS "t0"
  //   WHERE 1=1
  // ) AS "_count"
  // params: ["US"]

  console.log("2. Total US users (via CTE count):", total);
}

// --- 3. Referencing CTE: second CTE reads from the first ---

{
  const adults = User.query().where((u) => u.age >= 18);
  const ukAdults = User.query()
    .from("adults")
    .where((u) => u.country === "UK");
  const rows = await User.query()
    .withCte("adults", adults)
    .withCte("uk_adults", ukAdults)
    .from("uk_adults")
    .toArray();
  // SQL:
  // WITH "adults" AS (
  //   SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  //   FROM "users" AS "t0"
  //   WHERE ("t0"."age" >= ?)
  // ), "uk_adults" AS (
  //   SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  //   FROM "adults" AS "t0"
  //   WHERE ("t0"."country" = ?)
  // )
  // SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  // FROM "uk_adults" AS "t0"
  // WHERE 1=1
  // params: [18, "UK"]

  console.log(
    "3. UK adults via referencing CTE:",
    rows.map((u) => `${u.name} (${u.age})`),
  );
}

await db.close();
console.log("Done.");
