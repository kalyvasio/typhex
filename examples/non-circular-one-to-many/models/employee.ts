import { Entity } from "../../../src/index.js";

/** Employee has departmentId FK. No relations — Department has oneToMany to Employee (one-way, no circular refs). */
export class Employee extends Entity("employees", {
  id: "integer primary key autoincrement",
  name: "text not null",
  departmentId: "integer not null",
}) {}
