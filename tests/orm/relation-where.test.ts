import { describe, it, expect, beforeEach } from "vitest";
import { Db, createSqliteDriver, Entity, rel } from "../../src/index.js";

const Company = Entity("companies", {
  id: "integer primary key autoincrement",
  name: "text not null",
});

const Contact = Entity("contacts", {
  id: "integer primary key autoincrement",
  name: "text not null",
  email: "text",
  companyId: "integer not null",
}, {
  company: rel.manyToOne(() => Company, { foreignKey: "companyId" }),
});

const Employee = Entity("employees", {
  id: "integer primary key autoincrement",
  name: "text not null",
  departmentId: "integer not null",
});

const Department = Entity("departments", {
  id: "integer primary key autoincrement",
  name: "text not null",
}, {
  employees: rel.oneToMany(() => Employee, { foreignKey: "departmentId" }),
});

describe("relation where (JOIN)", () => {
  let db: Db;

  beforeEach(async () => {
    db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.migrate();
    const acme = await Company.query().insert({ name: "Acme Corp" });
    await Contact.query().insert({ name: "John", email: "j@acme.com", companyId: acme.id });
    await Contact.query().insert({ name: "Jane", email: "jane@acme.com", companyId: acme.id });
    const globex = await Company.query().insert({ name: "Globex" });
    await Contact.query().insert({ name: "Bob", email: "bob@globex.com", companyId: globex.id });
  });

  it("filters by relation property via JOIN", async () => {
    const rows = await Contact.query()
      .where((c: { company: { name: string } }) => c.company.name === "Acme Corp")
      .select((c: { id: number; name: string }) => ({ id: c.id, name: c.name }))
      .orderBy("id", "asc")
      .toArray();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(["John", "Jane"]);
  });

  it("where + select same relation reuses JOIN", async () => {
    const rows = await Contact.query()
      .where((c: { company: { name: string } }) => c.company.name === "Acme Corp")
      .select((c: { id: number; name: string; company: { id: number; name: string } }) => ({
        id: c.id,
        name: c.name,
        company: { id: c.company.id, name: c.company.name },
      }))
      .orderBy("id", "asc")
      .toArray();
    expect(rows).toHaveLength(2);
    expect(rows[0].company).toBeDefined();
    expect(rows[0].company?.name).toBe("Acme Corp");
  });

  it("count with relation where uses JOIN", async () => {
    const n = await Contact.query()
      .where((c: { company: { name: string } }) => c.company.name === "Acme Corp")
      .count();
    expect(n).toBe(2);
  });

  it("select-only relation uses whereIn (no JOIN)", async () => {
    const rows = await Contact.query()
      .select((c: { id: number; name: string; company: { id: number; name: string } }) => ({
        id: c.id,
        name: c.name,
        company: { id: c.company.id, name: c.company.name },
      }))
      .orderBy("id", "asc")
      .toArray();
    expect(rows).toHaveLength(3);
    expect(rows[0].company).toBeDefined();
    expect(rows.find((r) => r.name === "John")?.company?.name).toBe("Acme Corp");
    expect(rows.find((r) => r.name === "Bob")?.company?.name).toBe("Globex");
  });

  it("where with relation returns empty when no match", async () => {
    const rows = await Contact.query()
      .where((c: { company: { name: string } }) => c.company.name === "Nonexistent")
      .toArray();
    expect(rows).toHaveLength(0);
  });

  it("one-to-many: filters parent by child relation property via JOIN", async () => {
    const eng = await Department.query().insert({ name: "Engineering" });
    const sales = await Department.query().insert({ name: "Sales" });
    await Employee.query().insert({ name: "Alice", departmentId: eng.id });
    await Employee.query().insert({ name: "Bob", departmentId: eng.id });
    await Employee.query().insert({ name: "Carol", departmentId: sales.id });

    const rows = await Department.query()
      .where((d) => d.employees.some((e) => e.name === "Alice"))
      .select((d: { id: number; name: string }) => ({ id: d.id, name: d.name }))
      .orderBy("id", "asc")
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Engineering");
  });

  it("one-to-many: .where().some() with no select/orderBy infers root param correctly", async () => {
    const eng = await Department.query().insert({ name: "Engineering" });
    await Employee.query().insert({ name: "Alice", departmentId: eng.id });
    const rows = await Department.query()
      .where((d) => d.employees.some((e) => e.name === "Alice"))
      .toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect((rows as any[]).some((r) => r.name === "Engineering")).toBe(true);
  });
});
