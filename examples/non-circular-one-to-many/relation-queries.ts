/**
 * Non-circular oneToMany: Department → Employee. No declare, type flows from rel.oneToMany(() => Employee).
 * Run: npx tsx examples/non-circular-one-to-many/relation-queries.ts
 */

import { Db, createSqliteDriver } from "../../src/index.js";
import { Department, Employee } from "./models/index.js";

const db = new Db(createSqliteDriver({ path: ":memory:" }));
await db.migrate();

const engineering = await Department.query().insert({ name: "Engineering" });
const sales = await Department.query().insert({ name: "Sales" });
await Employee.query().insert({ name: "Alice", departmentId: engineering.id });
await Employee.query().insert({ name: "Bob", departmentId: engineering.id });
await Employee.query().insert({ name: "Carol", departmentId: sales.id });

const departmentsWithEmployees = await Department.query()
  .select(d => ({
    id: d.id,
    name: d.name,
    employees: d.employees.query().select(e => ({ id: e.id, name: e.name })),
  }))
  .orderBy("id", "asc")
  .toArray();

for (const d of departmentsWithEmployees) {
  const employeeNames = d.employees.map((e) => e.name).join(", ");
  console.log(`  Department ${d.id} "${d.name}": [${employeeNames}]`);
}

await db.close();
console.log("\nDone.");
