import { Entity } from "../../../src/index.js";

export class Tag extends Entity("tags", {
  id: "integer primary key autoincrement",
  name: "text not null",
}) {}
