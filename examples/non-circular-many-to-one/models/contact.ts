import { Entity, rel } from "../../../src/index.js";
import { Company } from "./company.js";

/** Contact has manyToOne to Company. No declare needed — type flows from rel.manyToOne(() => Company). */
export class Contact extends Entity(
  "contacts",
  {
    id: "integer primary key autoincrement",
    name: "text not null",
    email: "text",
    companyId: "integer not null",
  },
  {
    company: rel.manyToOne(() => Company, { foreignKey: "companyId" }),
  },
) {}
