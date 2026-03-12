import { Entity } from "../../../src/index.js";

/** Standalone entity with no relations. */
export class Company extends Entity("companies", {
  id: "integer primary key autoincrement",
  name: "text not null",
}) {}
