/**
 * CTE (WITH clause) examples: withCte, withRecursiveCte, unionAll, entity joins, update, delete.
 *
 * Requires the Typhex transformer (compiles .where(arrow) to IR). From examples/:
 *   npm install && npm run cte
 *
 * Section 3b: withCte callback + ctes.* in a single-arg where (transformer captures closure).
 * Sections 7–8: two-arg where (u, ctes) for CTE correlation at runtime without closure capture.
 *
 * Debug SQL: npm run cte:debug  (TYPHEX_DEBUG=1)
 */

import { Db, Entity, createSqliteDriver } from "typhex";

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
  // FROM "uk_adults" AS "t0" WHERE 1=1
  // params: [18, "UK"]

  console.log(
    "3. UK adults via referencing CTE:",
    rows.map((u) => `${u.name} (${u.age})`),
  );
}

// --- 3b. Later CTE: base table WHERE + registered CTE (withCte callback) ---
// Inner query: FROM users, correlate to "adults" in WHERE (not .from("adults")).

{
  const adults = User.query().where((u) => u.age >= 18);
  const rows = await User.query()
    .withCte("adults", adults)
    .withCte("uk_adults", (ctes) =>
      User.query().where((u) => u.country === "UK" && u.id === ctes.adults.id),
    )
    .from("uk_adults")
    .toArray();
  // SQL:
  // WITH "adults" AS (
  //   SELECT ... FROM "users" AS "t0" WHERE ("t0"."age" >= ?)
  // ), "uk_adults" AS (
  //   SELECT ... FROM "users" AS "t0", "adults"
  //   WHERE ("t0"."country" = ?) AND ("t0"."id" = "adults"."id")
  // )
  // SELECT ... FROM "uk_adults" AS "t0" WHERE 1=1
  // params: [18, "UK"]

  console.log(
    "3b. UK adults (users WHERE + ctes.adults.id):",
    rows.map((u) => `${u.name} (${u.age})`),
  );
}

// --- 4. unionAll: combine two SELECT branches ---

{
  const young = User.query().where((u) => u.age < 25);
  const senior = User.query().where((u) => u.age >= 65);
  const ends = await User.query()
    .withCte("ends", young.unionAll(senior))
    .from("ends")
    .orderBy("name", "asc")
    .toArray();
  // SQL:
  // WITH "ends" AS (
  //   SELECT ... FROM "users" WHERE ("t0"."age" < ?)
  //   UNION ALL
  //   SELECT ... FROM "users" WHERE ("t0"."age" >= ?)
  // )
  // SELECT ... FROM "ends" AS "t0" WHERE 1=1 ORDER BY "t0"."name" ASC
  // params: [25, 65]

  console.log(
    "4. Young or senior (unionAll via CTE):",
    ends.map((u) => `${u.name} (${u.age})`),
  );
}

// --- 5. Recursive CTE: anchor + self-referencing recursive step ---

{
  const anchor = User.query().where((u) => u.age >= 65);
  const recursive = User.query()
    .from("seniors")
    .where((u) => u.age >= 100);
  const body = anchor.unionAll(recursive);
  const seniors = await User.query().withRecursiveCte("seniors", body).from("seniors").toArray();
  // SQL:
  // WITH RECURSIVE "seniors" AS (
  //   SELECT ... FROM "users" WHERE ("t0"."age" >= ?)
  //   UNION ALL
  //   SELECT ... FROM "seniors" AS "t0" WHERE ("t0"."age" >= ?)
  // )
  // SELECT ... FROM "seniors" AS "t0" WHERE 1=1
  // params: [65, 100]

  console.log(
    "5. Seniors (recursive CTE, recursive step adds no rows here):",
    seniors.map((u) => `${u.name} (${u.age})`),
  );
}

// --- 6. Entity-table join: innerJoin(Entity, on) ---

{
  const withPeer = await User.query()
    .innerJoin(User, (peer, u) => peer.country === u.country && peer.id !== u.id)
    .where((u) => u.name === "Alice")
    .toArray();
  // SQL:
  // SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  // FROM "users" AS "t0"
  // INNER JOIN "users" AS "t1"
  //   ON (("t1"."country" = "t0"."country") AND ("t1"."id" <> "t0"."id"))
  // WHERE ("t0"."name" = ?)
  // params: ["Alice"]

  console.log(
    "6. Alice has a same-country peer:",
    withPeer.length === 1 ? withPeer[0]!.name : "(none)",
  );
}

// --- 7. UPDATE via CTE: mutate rows selected through a registered CTE ---

{
  const adults = User.query().where((u) => u.age >= 18);
  await User.query()
    .withCte("adults", adults)
    .where((u, ctes) => u.age === 35 && u.id === ctes.adults.id)
    .update({ name: "Robert" });
  // SQL:
  // WITH "adults" AS (
  //   SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  //   FROM "users" AS "t0"
  //   WHERE ("t0"."age" >= ?)
  // )
  // UPDATE "users" AS "t0"
  // SET "name" = ?
  // FROM "adults"
  // WHERE ("t0"."age" = ?) AND ("t0"."id" = "adults"."id")
  // params: [18, "Robert", 35]

  const bob = await User.query()
    .where((u) => u.name === "Robert")
    .first();
  console.log("7. Bob renamed via CTE update:", bob ? `${bob.name} (${bob.age})` : "(not found)");
}

// --- 8. DELETE via CTE: remove rows matching a filter on a CTE result ---

{
  const ukAdults = User.query().where((u) => u.country === "UK" && u.age >= 18);
  const removed = await User.query()
    .withCte("uk_adults", ukAdults)
    .where((u, ctes) => u.age >= 65 && u.id === ctes.uk_adults.id)
    .delete();
  // SQL:
  // WITH "uk_adults" AS (
  //   SELECT "t0"."id", "t0"."name", "t0"."age", "t0"."country"
  //   FROM "users" AS "t0"
  //   WHERE (("t0"."country" = ?) AND ("t0"."age" >= ?))
  // )
  // DELETE FROM "users" AS "t0"
  // WHERE EXISTS (
  //   SELECT 1 FROM "uk_adults"
  //   WHERE ("t0"."age" >= ?) AND ("t0"."id" = "uk_adults"."id")
  // )
  // params: ["UK", 18, 65]

  console.log("8. UK seniors deleted via CTE:", removed);
}

await db.close();
console.log("Done.");
