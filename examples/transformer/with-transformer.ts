/**
 * Transformer example: closure variables are auto-captured at compile time.
 * Also demonstrates aggregate functions (count/sum/avg/min/max), groupBy, and having.
 * Build and run: npm run transformer  (from examples/)
 */

import { Db, Entity, createSqliteDriver, count, avg, max } from "typhex";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
  country: "text",
  salary: "integer",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

await User.query().insert({ name: "John", age: 40, country: "US", salary: 90000 });
await User.query().insert({ name: "Alice", age: 30, country: "US", salary: 75000 });
await User.query().insert({ name: "Bob", age: 25, country: "UK", salary: 60000 });
await User.query().insert({ name: "Carol", age: 28, country: "US", salary: 80000 });

const country = "US";
const fromUS = await User.query()
  .where((u) => u.country === country)
  .toArray();
console.log("From US (closure, no params arg):", fromUS);

const minAge = 25;
const maxAge = 35;
const inAgeRange = await User.query()
  .where((u) => u.age != null && u.age >= minAge && u.age <= maxAge)
  .orderBy("name", "asc")
  .toArray();
console.log("Age 25–35:", inAgeRange);

const namesStartingWithA = await User.query()
  .where((u) => u.name.startsWith("A"))
  .toArray();
console.log("Names starting with 'A':", namesStartingWithA);

const namesContainingAl = await User.query()
  .where((u) => u.name.includes("al"))
  .toArray();
console.log("Names containing 'al':", namesContainingAl);

const selectedUsers = await User.query()
  .where((u) => u.id in [1, 2])
  .toArray();
console.log("Users with IDs in [1, 2] (literal):", selectedUsers);

const notInIds = await User.query()
  .where((u) => !(u.id in [2]))
  .toArray();
console.log("Users with ID not in [2]:", notInIds);

const projected = await User.query()
  .select((u) => ({ id: u.id, name: u.name }))
  .toArray();
console.log("Select id and name:", projected);

const withAliases = await User.query()
  .select((u) => ({ userId: u.id, fullName: u.name, country: u.country }))
  .where((u) => u.country === "US")
  .toArray();
console.log("Select with aliases (US only):", withAliases);

// --- Shorthand select forms ---

// select * (p => p)
const allUsers = await User.query()
  .select((u) => u)
  .toArray();
console.log("Select * shorthand:", allUsers);

// single column (p => p.name)
const names = await User.query()
  .select((u) => u.name)
  .toArray();
console.log("Single column shorthand (names):", names);

// --- Aggregate functions ---

// select count(p.id)
const totalCount = await User.query()
  .select((u) => count(u.id))
  .toArray();
console.log("Count all:", totalCount);

// select with multiple aggregates in an object
const stats = await User.query()
  .select((u) => ({ total: count(u.id), avgAge: avg(u.age), maxSalary: max(u.salary) }))
  .toArray();
console.log("Aggregate stats:", stats);

// --- groupBy + aggregate ---

const byCountry = await User.query()
  .select((u) => ({ country: u.country, headcount: count(u.id), avgSalary: avg(u.salary) }))
  .groupBy((u) => u.country)
  .toArray();
console.log("Group by country:", byCountry);

// --- groupBy + having ---

const minHeadcount = 2;
const bigCountries = await User.query()
  .select((u) => ({ country: u.country, headcount: count(u.id) }))
  .groupBy((u) => u.country)
  .having((u) => count(u.id) >= minHeadcount)
  .toArray();
console.log(`Countries with >= ${minHeadcount} users:`, bigCountries);

await db.close();
console.log("Done.");
