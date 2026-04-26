/**
 * PostgreSQL example. Requires a running PostgreSQL instance.
 * Run: npx tsx examples/postgres/postgres.ts
 *
 * Set connection via env:
 *   TYPHEX_POSTGRES_URL=postgresql://user:pass@localhost:5432/mydb
 */

import { Db, Entity, createPostgresDriver } from "../../src/index.js";

const User = Entity("pg_users", {
  id: "SERIAL PRIMARY KEY",
  name: "VARCHAR(255) NOT NULL",
  age: "INTEGER NOT NULL",
  country: "VARCHAR(100) NOT NULL",
});

const connectionString =
  process.env.TYPHEX_POSTGRES_URL ?? "postgresql://localhost:5432/typhex_test";

const driver = createPostgresDriver({ connectionString });
const db = new Db(driver);

await db.migrate();

await User.query().insert({ name: "Alice", age: 30, country: "US" });
await User.query().insert({ name: "Bob", age: 25, country: "UK" });
await User.query().insert({ name: "Carol", age: 28, country: "US" });

const adults = await User.query()
  .where((u) => u.age > 18)
  .toArray();
console.log("Adults:", adults);

const country = "US";
const fromUS = await User.query()
  .where((u) => u.country === country, { country })
  .toArray();
console.log("From US:", fromUS);

const first = await User.query()
  .where((u) => u.age >= 25)
  .orderBy("name", "asc")
  .first();
console.log("First (age>=25, by name):", first);

const n = await User.query()
  .where((u) => u.country === "US")
  .count();
console.log("Count US:", n);

const names = await User.query()
  .where((u) => u.age > 20)
  .select(["name", "country"])
  .toArray();
console.log("Names only:", names);

const namesStartingWithA = await User.query()
  .where((u) => u.name.startsWith("A"))
  .toArray();
console.log("Names starting with 'A':", namesStartingWithA);

const selectedUsers = await User.query()
  .where((u) => u.id in [1, 3])
  .toArray();
console.log("Users with IDs in [1, 3]:", selectedUsers);

const updated = await User.query()
  .where((u) => u.name === "Bob")
  .update({ age: 26 });
console.log("Updated rows:", updated);

const dave = new User({ name: "Dave", age: 35, country: "US" });
await dave.query().save();
console.log("Saved Dave, id:", dave.id);

await dave.query().delete();
console.log("Deleted Dave");

await db.close();
console.log("Done.");
