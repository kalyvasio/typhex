/**
 * Relation where: filter by related entity properties via JOIN.
 * Run: npx tsx examples/relation-where/relation-where.ts
 *
 * - Relations in where → JOIN (many-to-one) or EXISTS (one-to-many).
 * - Relations in select only → whereIn (separate query).
 * - Relation in both where and select → reuse the JOIN when many-to-one.
 */

import { Db, createSqliteDriver } from "../../src/index.js";
import { Category, Company, Contact, Department, Employee } from "./models/index.js";

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

const acme = await Company.query().insert({ name: "Acme Corp" });
const globex = await Company.query().insert({ name: "Globex" });
const sales = await Category.query().insert({ name: "Sales" });
const eng = await Category.query().insert({ name: "Engineering" });
await Contact.query().insert({ name: "John Doe", email: "john@acme.com", companyId: acme.id, categoryId: sales.id });
await Contact.query().insert({ name: "Jane Smith", email: "jane@acme.com", companyId: acme.id, categoryId: eng.id });
await Contact.query().insert({ name: "Bob Wilson", email: "bob@globex.com", companyId: globex.id, categoryId: sales.id });

const engineering = await Department.query().insert({ name: "Engineering" });
const salesDept = await Department.query().insert({ name: "Sales" });
await Employee.query().insert({ name: "Alice", departmentId: engineering.id });
await Employee.query().insert({ name: "Bob", departmentId: engineering.id });
await Employee.query().insert({ name: "Carol", departmentId: salesDept.id });

console.log("=== where with relation: contacts at Acme Corp ===");
const acmeContacts = await Contact.query()
  .where(c => c.company.name === "Acme Corp")
  .select(c => ({ id: c.id, name: c.name }))
  .orderBy("id", "asc")
  .toArray();
for (const c of acmeContacts) {
  console.log(`  Contact ${c.id} "${c.name}"`);
}

console.log("\n=== where + select same relation (JOIN reuse) ===");
const acmeContactsWithCompany = await Contact.query()
  .where(c => c.company.name === "Acme Corp")
  .select(c => ({
    id: c.id,
    name: c.name,
    company: { id: c.company.id, name: c.company.name },
  }))
  .orderBy("id", "asc")
  .toArray();
for (const c of acmeContactsWithCompany) {
  console.log(`  Contact ${c.id} "${c.name}" at "${c.company.name}"`);
}

console.log("\n=== all columns + one relation: (c) => ({ ...c, company: c.company }) ===");
const contactsAllColsWithCompany = await Contact.query()
  .select(c => ({ ...c, company: c.company }))
  .orderBy("id", "asc")
  .toArray();
for (const c of contactsAllColsWithCompany) {
  console.log(`  Contact ${c.id} "${c.name}" at "${c.company?.name ?? "—"}"`);
}

console.log("\n=== where uses company, select uses category (different relations) ===");
const acmeContactsWithCategory = await Contact.query()
  .where(c => c.company.name === "Acme Corp")
  .select(c => ({
    id: c.id,
    name: c.name,
    category: { id: c.category.id, name: c.category.name },
  }))
  .orderBy("id", "asc")
  .toArray();
for (const c of acmeContactsWithCategory) {
  console.log(`  Contact ${c.id} "${c.name}" in category "${c.category?.name ?? "—"}"`);
}

console.log("\n=== where with one-to-many: departments that have an employee named Alice ===");
const deptsWithAlice = await Department.query()
  .where(d => d.employees.some((e) => e.name === "Alice"))
  .select(d => ({ id: d.id, name: d.name }))
  .orderBy("id", "asc")
  .toArray();
for (const d of deptsWithAlice) {
  console.log(`  Department ${d.id} "${d.name}"`);
}

console.log("\n=== count with relation where ===");
const acmeCount = await Contact.query()
  .where(c => c.company.name === "Acme Corp")
  .count();
console.log(`  Acme contacts: ${acmeCount}`);

await db.close();
console.log("\nDone.");
