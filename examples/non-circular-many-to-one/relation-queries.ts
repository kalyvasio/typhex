/**
 * Non-circular manyToOne: Contact → Company. No declare, type flows from rel.manyToOne(() => Company).
 * Run: npx tsx examples/non-circular-many-to-one/relation-queries.ts
 */

import { Db, createSqliteDriver } from "../../src/index.js";
import { Company, Contact } from "./models/index.js";

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

const acme = await Company.query().insert({ name: "Acme Corp" });
const globex = await Company.query().insert({ name: "Globex" });
await Contact.query().insert({ name: "John Doe", email: "john@acme.com", companyId: acme.id });
await Contact.query().insert({ name: "Jane Smith", email: "jane@acme.com", companyId: acme.id });
await Contact.query().insert({ name: "Bob Wilson", email: "bob@globex.com", companyId: globex.id });

const contactsWithCompany = await Contact.query()
  .select((c) => ({ id: c.id, name: c.name, company: { id: c.company.id, name: c.company.name } }))
  .orderBy("id", "asc")
  .toArray();

for (const c of contactsWithCompany) {
  console.log(`  Contact ${c.id} "${c.name}" at company "${c.company.name}"`);
}

await db.close();
console.log("\nDone.");
