import { Entity, rel } from "../../../src/index.js";
import { Category } from "./category.js";
import { Company } from "./company.js";

export class Contact extends Entity("contacts", {
  id: "integer primary key autoincrement",
  name: "text not null",
  email: "text",
  companyId: "integer not null",
  categoryId: "integer",
}, {
  company: rel.manyToOne(() => Company, { foreignKey: "companyId" }),
  category: rel.manyToOne(() => Category, { foreignKey: "categoryId" }),
}) {}
