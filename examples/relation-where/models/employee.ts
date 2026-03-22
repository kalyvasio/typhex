import { Entity } from "../../../src/index.js";

export class Employee extends Entity("employees", {
  id: "integer primary key autoincrement",
  name: "text not null",
  departmentId: "integer not null",
}) {}
