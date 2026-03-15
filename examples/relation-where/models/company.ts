import { Entity } from "../../../src/index.js";

export class Company extends Entity("companies", {
  id: "integer primary key autoincrement",
  name: "text not null",
}) {}
