import { Entity, rel } from "../../../src/index.js";
import { Employee } from "./employee.js";

/** Department has oneToMany to Employee. No declare needed — type flows from rel.oneToMany(() => Employee). */
export class Department extends Entity("departments", {
  id: "integer primary key autoincrement",
  name: "text not null",
}, {
  employees: rel.oneToMany(() => Employee, { foreignKey: "departmentId" }),
}) {}
