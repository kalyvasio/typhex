/**
 * Same as basic example but written for the compile-time transformer:
 * closure variables are used in predicates without passing a second argument.
 * See examples/README.md for how to build and run.
 */

import { Db, createSqliteDriver } from "typhex";

const driver = createSqliteDriver({ path: ":memory:" });
const db = new Db(driver);

interface User {
  id?: number;
  name: string;
  age: number;
  country: string;
}

const users = db.defineTable<User>("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
  country: "text",
});

db.migrate();

users.insert({ name: "John", age: 40, country: "US" });
users.insert({ name: "Alice", age: 30, country: "US" });
users.insert({ name: "Bob", age: 25, country: "UK" });
users.insert({ name: "Carol", age: 28, country: "US" });

// No second argument: closure variable `country` is captured by the transformer
const country = "US";
const fromUS = users.where((u: User) => u.country === country).toArray();
console.log("From US (closure, no params arg):", fromUS);

// Multiple closure variables work the same way
const minAge = 25;
const maxAge = 35;
const inAgeRange = users
  .where((u: User) => u.age >= minAge && u.age <= maxAge)
  .orderBy("name", "asc")
  .toArray();
console.log("Age 25–35:", inAgeRange);

// String methods: startsWith, includes
const namesStartingWithA = users.where((u: User) => u.name.startsWith("A")).toArray();
console.log("Names starting with 'A':", namesStartingWithA);

const namesContainingAl = users.where((u: User) => u.name.includes("al")).toArray();
console.log("Names containing 'al':", namesContainingAl);

// Array membership with 'in' operator (array literal)
// Note: In practice, auto-increment IDs are always defined
const selectedUsers = users.where((u: User) => (u.id as number) in [1, 2]).toArray();
console.log("Users with IDs in [1, 2] (literal):", selectedUsers);

// Not in: negate with !
const notInIds = users.where((u: User) => !((u.id as number) in [2])).toArray();
console.log("Users with ID not in [2]:", notInIds);

// Select with rest: id first, then all other columns
const idAndRest = users.select(({ id, ...rest }) => ({ id, ...rest })).toArray();
console.log("Select id + rest:", idAndRest);

const projected = users.select(({ id, name }) => ({ id, name })).toArray();
console.log("Select id and name (destructuring):", projected);

const projectedExplicit = users.select((u: User) => ({ id: u.id, name: u.name })).toArray();
console.log("Select id and name (explicit param):", projectedExplicit);

// Select with aliases (object keys become SQL AS)
const withAliases = users
  .select((u: User) => ({ userId: u.id, fullName: u.name, country: u.country }))
  .where((u: User) => u.country === "US")
  .toArray();
console.log("Select with aliases (US only):", withAliases);

driver.close();
console.log("Done.");
