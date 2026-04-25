/**
 * Basic Typhex usage: Entity definition, runtime arrow-function where, CRUD.
 * Run: npx tsx examples/basic/basic.ts  (from project root)
 *   or: npm run basic  (from examples/)
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

await User.query().insert({ name: "Alice", age: 30, country: "US" });
await User.query().insert({ name: "Bob", age: 25, country: "UK" });
await User.query().insert({ name: "Carol", age: 28, country: "US" });

const adults = await User.query().where((u) => u.age > 18).toArray();
console.log("Adults:", adults);

const country = "US";
const fromUS = await User.query().where((u) => u.country === country, { country }).toArray();
console.log("From US:", fromUS);

const first = await User.query().where((u) => u.age >= 25).orderBy("name", "asc").first();
console.log("First (age>=25, by name):", first);

const n = await User.query().where((u) => u.country === "US").count();
console.log("Count US:", n);

const names = await User.query().where((u) => u.age > 20).select(["name", "country"]).toArray();
console.log("Names only:", names);

const namesStartingWithA = await User.query().where((u) => u.name.startsWith("A")).toArray();
console.log("Names starting with 'A':", namesStartingWithA);

const namesContainingAl = await User.query().where((u) => u.name.includes("al")).toArray();
console.log("Names containing 'al':", namesContainingAl);

const selectedUsers = await User.query().where((u) => u.id in [1, 3]).toArray();
console.log("Users with IDs in [1, 3]:", selectedUsers);

const ids = [1, 2];
const selectedUsers2 = await User.query().where((u) => u.id in ids, { ids }).toArray();
console.log("Users with IDs in [1, 2] (variable):", selectedUsers2);

const notInIds = await User.query().where((u) => !(u.id in [2])).toArray();
console.log("Users with ID not in [2]:", notInIds);

const updated = await User.query().where((u) => u.name === "Bob").update({ age: 26 });
console.log("Updated rows:", updated);

const deleted = await User.query().where((u) => u.country === "UK").delete();
console.log("Deleted rows:", deleted);

const dave = new User({ name: "Dave", age: 35, country: "US" });
await dave.query().save();
console.log("Saved Dave, id:", dave.id);

await dave.query().delete();
console.log("Deleted Dave");

await db.close();
console.log("Done.");
