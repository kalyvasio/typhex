/**
 * Basic Typhex ORM usage: arrow-function where + CRUD.
 * Run: npm run example (or npx tsx examples/basic.ts)
 */

import { Db, createSqliteDriver } from "../src/index.js";

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

users.insert({ name: "Alice", age: 30, country: "US" });
users.insert({ name: "Bob", age: 25, country: "UK" });
users.insert({ name: "Carol", age: 28, country: "US" });

// Arrow-function where (parsed at runtime)
const adults = users.where((u) => u.age > 18).toArray();
console.log("Adults:", adults);

// With param (pass closure values as second arg)
const country = "US";
const fromUS = users.where((u) => u.country === country, { country }).toArray();
console.log("From US:", fromUS);

// Fluent API
const first = users.where((u) => u.age >= 25).orderBy("name", "asc").limit(1).first();
console.log("First (age>=25, by name):", first);

// Count
const n = users.where((u) => u.country === "US").count();
console.log("Count US:", n);

// Select specific columns
const names = users.where((u) => u.age > 20).select(["name", "country"]).toArray();
console.log("Names only:", names);

// Update
const updated = users.update((u) => u.name === "Bob", { age: 26 });
console.log("Updated rows:", updated);

// Delete
const deleted = users.delete((u) => u.country === "UK");
console.log("Deleted rows:", deleted);

driver.close();
console.log("Done.");
