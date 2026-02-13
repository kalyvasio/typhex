/**
 * Same as basic example but written for the compile-time transformer:
 * closure variables are used in predicates without passing a second argument.
 *
 * Build and run with: npm run example:transformer
 * (Compiles this file with typhex/transformer so .where(ir, { country }) is emitted for you.)
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

driver.close();
console.log("Done.");
