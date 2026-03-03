/**
 * Transformer example: closure variables are auto-captured at compile time.
 * Build and run: npm run transformer  (from examples/)
 */

import { Db, Entity, createSqliteDriver } from "typhex";

const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
  country: "text",
});

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

await User.query().insert({ name: "John", age: 40, country: "US" });
await User.query().insert({ name: "Alice", age: 30, country: "US" });
await User.query().insert({ name: "Bob", age: 25, country: "UK" });
await User.query().insert({ name: "Carol", age: 28, country: "US" });

const country = "US";
const fromUS = await User.query().where((u) => u.country === country).toArray();
console.log("From US (closure, no params arg):", fromUS);

const minAge = 25;
const maxAge = 35;
const inAgeRange = await User.query()
  .where((u) => u.age != null && u.age >= minAge && u.age <= maxAge)
  .orderBy("name", "asc")
  .toArray();
console.log("Age 25–35:", inAgeRange);

const namesStartingWithA = await User.query().where((u) => u.name.startsWith("A")).toArray();
console.log("Names starting with 'A':", namesStartingWithA);

const namesContainingAl = await User.query().where((u) => u.name.includes("al")).toArray();
console.log("Names containing 'al':", namesContainingAl);

const selectedUsers = await User.query().where((u) => u.id in [1, 2]).toArray();
console.log("Users with IDs in [1, 2] (literal):", selectedUsers);

const notInIds = await User.query().where((u) => !(u.id in [2])).toArray();
console.log("Users with ID not in [2]:", notInIds);

const projected = await User.query().select((u) => ({ id: u.id, name: u.name })).toArray();
console.log("Select id and name:", projected);

const withAliases = await User.query()
  .select((u) => ({ userId: u.id, fullName: u.name, country: u.country }))
  .where((u) => u.country === "US")
  .toArray();
console.log("Select with aliases (US only):", withAliases);

await db.close();
console.log("Done.");
