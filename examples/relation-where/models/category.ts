import { Entity } from "../../../src/index.js";

export class Category extends Entity("categories", {
  id: "integer primary key autoincrement",
  name: "text not null",
}) {}
