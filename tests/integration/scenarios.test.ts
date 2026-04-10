/**
 * Integration scenarios: full ORM workflows covering CRUD, entity subclassing,
 * non-circular relations, circular-style relations, and relation-where (JOIN / EXISTS).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Db, Entity, rel } from "../../src/index.js";
import { clearRegistry, registerEntity } from "../../src/entity/global-driver.js";
import { freshDb } from "../helpers.js";

// ─── basic CRUD ───────────────────────────────────────────────────────────────

describe("basic CRUD", () => {
  const User = Entity("users", {
    id: "integer primary key autoincrement",
    name: "text not null",
    age: "integer not null",
    country: "text not null",
  });

  let db: Db;
  beforeEach(async () => {
    clearRegistry();
    registerEntity(User);
    db = freshDb();
    await db.migrate();
    await User.query().insert({ name: "Alice", age: 30, country: "US" });
    await User.query().insert({ name: "Bob",   age: 25, country: "UK" });
    await User.query().insert({ name: "Carol", age: 28, country: "US" });
  });
  afterEach(async () => { await db.close(); });

  it("where age > 18 returns all rows", async () => {
    const rows = await User.query().where((u) => u.age > 18).toArray();
    expect(rows).toHaveLength(3);
  });

  it("where with closure variable filters by country", async () => {
    const country = "US";
    const rows = await User.query().where((u) => u.country === country, { country }).toArray();
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.country === "US")).toBe(true);
  });

  it("orderBy + limit + first", async () => {
    const row = await User.query()
      .where((u) => u.age >= 25)
      .orderBy("name", "asc")
      .limit(1)
      .first();
    expect((row as any).name).toBe("Alice");
  });

  it("count with where", async () => {
    const n = await User.query().where((u) => u.country === "US").count();
    expect(n).toBe(2);
  });

  it("select subset of columns", async () => {
    const rows = await User.query()
      .where((u) => u.age > 20)
      .select(["name", "country"])
      .toArray();
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toHaveProperty("id");
  });

  it("startsWith string filter", async () => {
    const rows = await User.query().where((u) => u.name.startsWith("A")).toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).name).toBe("Alice");
  });

  it("includes string filter (case-insensitive in SQLite)", async () => {
    // SQLite LIKE is case-insensitive for ASCII, so 'al' matches 'Al' in 'Alice'
    const rows = await User.query().where((u) => u.name.includes("al")).toArray();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).name).toBe("Alice");
  });

  it("in literal array filter", async () => {
    const rows = await User.query().where((u) => u.id in [1, 3]).toArray();
    expect(rows).toHaveLength(2);
    const names = rows.map((r: any) => r.name).sort();
    expect(names).toEqual(["Alice", "Carol"]);
  });

  it("in variable array filter", async () => {
    const ids = [1, 2];
    const rows = await User.query().where((u) => u.id in ids, { ids }).toArray();
    expect(rows).toHaveLength(2);
  });

  it("negated in filter", async () => {
    const rows = await User.query().where((u) => !(u.id in [2])).toArray();
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.id !== 2)).toBe(true);
  });

  it("update rows", async () => {
    const changed = await User.query().where((u) => u.name === "Bob").update({ age: 26 });
    expect(changed).toBe(1);
    const bob = await User.query().where((u) => u.name === "Bob").first();
    expect((bob as any).age).toBe(26);
  });

  it("delete rows", async () => {
    const deleted = await User.query().where((u) => u.country === "UK").delete();
    expect(deleted).toBe(1);
    expect(await User.query().count()).toBe(2);
  });

  it("instance save and delete", async () => {
    const dave = new User({ name: "Dave", age: 35, country: "US" });
    await dave.query().save();
    expect((dave as any).id).toBeDefined();
    expect(await User.query().count()).toBe(4);
    await dave.query().delete();
    expect(await User.query().count()).toBe(3);
  });
});

// ─── insertMany ───────────────────────────────────────────────────────────────

describe("insertMany", () => {
  const Product = Entity("products", {
    id: "integer primary key autoincrement",
    name: "text not null",
    price: "integer not null",
  });

  let db: Db;
  beforeEach(async () => {
    clearRegistry();
    registerEntity(Product);
    db = freshDb();
    await db.migrate();
  });
  afterEach(async () => { await db.close(); });

  it("inserts multiple rows and rows are persisted", async () => {
    await Product.query().insertMany([
      { name: "Pen",    price: 1 },
      { name: "Pencil", price: 2 },
      { name: "Ruler",  price: 3 },
    ]);
    expect(await Product.query().count()).toBe(3);
  });

  it("returns empty array for empty input without hitting db", async () => {
    const rows = await Product.query().insertMany([]);
    expect(rows).toEqual([]);
    expect(await Product.query().count()).toBe(0);
  });

  it("sparse rows insert correctly (missing column uses DB default)", async () => {
    const Product2 = Entity("products2", {
      id: "integer primary key autoincrement",
      a: "text",
      b: "text",
    });
    registerEntity(Product2);
    await db.run(`CREATE TABLE IF NOT EXISTS "products2" ("id" integer primary key autoincrement, "a" text, "b" text)`);
    await Product2.query().insertMany([
      { a: "hello" },
      { b: "world" },
    ]);
    const all = await Product2.query().orderBy("id", "asc").toArray();
    expect(all).toHaveLength(2);
    expect((all[0] as any).a).toBe("hello");
    expect((all[0] as any).b).toBeNull();
    expect((all[1] as any).a).toBeNull();
    expect((all[1] as any).b).toBe("world");
  });
});

// ─── entity subclassing & lifecycle ───────────────────────────────────────────

describe("entity subclassing and lifecycle hooks", () => {
  const User = Entity("users", {
    id: "integer primary key autoincrement",
    name: "text not null",
    email: "text",
    age: "integer",
    createdAt: "datetime not null",
  });

  const Post = Entity(
    "posts",
    {
      id: "integer primary key autoincrement",
      title: "text not null",
      body: "text",
      authorId: "integer not null",
      published: "boolean",
      createdAt: "datetime not null",
    },
    { author: rel.manyToOne(() => User, { foreignKey: "authorId" }) }
  );

  class UserEntity extends User {
    get displayName() {
      return (this as any).name ?? (this as any).email ?? "Anonymous";
    }
    beforeSave() {
      if (!(this as any).createdAt) (this as any).createdAt = new Date();
    }
  }

  let db: Db;
  beforeEach(async () => {
    clearRegistry();
    registerEntity(User);
    registerEntity(Post);
    db = freshDb();
    await db.migrate();
  });
  afterEach(async () => { await db.close(); });

  it("insert returns hydrated instance with id", async () => {
    const alice = await User.query().insert({ name: "Alice", email: "alice@example.com", age: 30, createdAt: new Date() });
    expect((alice as any).id).toBeDefined();
    expect((alice as any).name).toBe("Alice");
  });

  it("subclass query returns instances with computed getter", async () => {
    await User.query().insert({ name: "Alice", email: "alice@example.com", age: 30, createdAt: new Date() });
    await User.query().insert({ name: "Bob", age: 25, createdAt: new Date() });

    const adults = await UserEntity.query().where((u) => u.age > 18).toArray();
    expect(adults).toHaveLength(2);

    const first = await UserEntity.query().where((u) => u.age > 18).first();
    expect((first as any).displayName).toBeDefined();
  });

  it("findById returns correct instance", async () => {
    const alice = await User.query().insert({ name: "Alice", email: "alice@example.com", age: 30, createdAt: new Date() });
    const found = await User.query().findById((alice as any).id!);
    expect((found as any)?.name).toBe("Alice");
  });

  it("findById returns null for missing id", async () => {
    const found = await User.query().findById(999);
    expect(found).toBeNull();
  });

  it("new instance save sets id and beforeSave fires", async () => {
    const carol = new UserEntity({ name: "Carol", email: "carol@example.com", age: 28 } as any);
    await carol.query().save();
    expect((carol as any).id).toBeDefined();
    expect((carol as any).createdAt).toBeDefined();
  });

  it("post where published filters correctly", async () => {
    const alice = await User.query().insert({ name: "Alice", email: "alice@example.com", age: 30, createdAt: new Date() });
    await Post.query().insert({ title: "Published", body: "x", authorId: (alice as any).id!, published: true, createdAt: new Date() });
    await Post.query().insert({ title: "Draft", body: "y", authorId: (alice as any).id!, published: false, createdAt: new Date() });

    const p = await Post.query().where((p) => p.published === true).first();
    expect((p as any)?.title).toBe("Published");
  });
});

// ─── non-circular many-to-one ─────────────────────────────────────────────────

describe("non-circular many-to-one relation", () => {
  const Company = Entity("companies", {
    id: "integer primary key autoincrement",
    name: "text not null",
  });

  const Contact = Entity(
    "contacts",
    {
      id: "integer primary key autoincrement",
      name: "text not null",
      email: "text",
      companyId: "integer not null",
    },
    { company: rel.manyToOne(() => Company, { foreignKey: "companyId" }) }
  );

  let db: Db;
  beforeEach(async () => {
    clearRegistry();
    registerEntity(Company);
    registerEntity(Contact);
    db = freshDb();
    await db.migrate();
    const acme   = await Company.query().insert({ name: "Acme Corp" });
    const globex = await Company.query().insert({ name: "Globex" });
    await Contact.query().insert({ name: "John Doe",   email: "john@acme.com",  companyId: (acme as any).id });
    await Contact.query().insert({ name: "Jane Smith", email: "jane@acme.com",  companyId: (acme as any).id });
    await Contact.query().insert({ name: "Bob Wilson", email: "bob@globex.com", companyId: (globex as any).id });
  });
  afterEach(async () => { await db.close(); });

  it("select with partial relation loads company name", async () => {
    const rows = await Contact.query()
      .select((c: any) => ({ id: c.id, name: c.name, company: { id: c.company.id, name: c.company.name } }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(3);
    expect((rows[0] as any).company.name).toBe("Acme Corp");
    expect((rows[2] as any).company.name).toBe("Globex");
  });
});

// ─── non-circular one-to-many ─────────────────────────────────────────────────

describe("non-circular one-to-many relation", () => {
  const Employee = Entity("employees", {
    id: "integer primary key autoincrement",
    name: "text not null",
    departmentId: "integer not null",
  });

  const Department = Entity(
    "departments",
    {
      id: "integer primary key autoincrement",
      name: "text not null",
    },
    { employees: rel.oneToMany(() => Employee, { foreignKey: "departmentId" }) }
  );

  let db: Db;
  beforeEach(async () => {
    clearRegistry();
    registerEntity(Employee);
    registerEntity(Department);
    db = freshDb();
    await db.migrate();
    const eng   = await Department.query().insert({ name: "Engineering" });
    const sales = await Department.query().insert({ name: "Sales" });
    await Employee.query().insert({ name: "Alice", departmentId: (eng as any).id });
    await Employee.query().insert({ name: "Bob",   departmentId: (eng as any).id });
    await Employee.query().insert({ name: "Carol", departmentId: (sales as any).id });
  });
  afterEach(async () => { await db.close(); });

  it("select with oneToMany loads employees per department", async () => {
    const rows = await Department.query()
      .select((d: any) => ({
        id: d.id,
        name: d.name,
        employees: d.employees.query().select((e: any) => ({ id: e.id, name: e.name })),
      }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows[0] as any).employees).toHaveLength(2);
    expect((rows[1] as any).employees).toHaveLength(1);
    const engNames = (rows[0] as any).employees.map((e: any) => e.name).sort();
    expect(engNames).toEqual(["Alice", "Bob"]);
  });
});

// ─── circular-style relations ─────────────────────────────────────────────────

describe("circular-style bidirectional relations", () => {
  const User = Entity(
    "users",
    { id: "integer primary key autoincrement", name: "text not null", email: "text" },
    { posts: rel.oneToMany(() => Post, { foreignKey: "authorId" }) }
  );

  const Post = Entity(
    "posts",
    { id: "integer primary key autoincrement", title: "text not null", body: "text", authorId: "integer not null", published: "boolean" },
    { author: rel.manyToOne(() => User, { foreignKey: "authorId" }) }
  );

  let db: Db;
  beforeEach(async () => {
    clearRegistry();
    registerEntity(User);
    registerEntity(Post);
    db = freshDb();
    await db.migrate();
    const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
    const bob   = await User.query().insert({ name: "Bob",   email: "bob@example.com" });
    await Post.query().insert({ title: "First post",     body: "Hello world.", authorId: (alice as any).id, published: true });
    await Post.query().insert({ title: "Draft",          body: "WIP...",       authorId: (bob as any).id,   published: false });
    await Post.query().insert({ title: "Alice's second", body: "Another one.", authorId: (alice as any).id, published: true });
  });
  afterEach(async () => { await db.close(); });

  it("manyToOne: each post loads its author", async () => {
    const rows = await Post.query()
      .select((p: any) => ({ id: p.id, title: p.title, author: p.author }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(3);
    expect((rows[0] as any).author?.name).toBe("Alice");
    expect((rows[1] as any).author?.name).toBe("Bob");
    expect((rows[2] as any).author?.name).toBe("Alice");
  });

  it("partial relation select omits extra fields", async () => {
    const rows = await Post.query()
      .select((p: any) => ({ id: p.id, author: { id: p.author.id, name: p.author.name } }))
      .toArray();

    expect(rows[0].author).toMatchObject({ name: "Alice" });
    expect(rows[0].author).not.toHaveProperty("email");
  });

  it("oneToMany: each user loads their posts", async () => {
    const rows = await User.query()
      .select((u: any) => ({
        id: u.id,
        name: u.name,
        posts: u.posts.query().select((p: any) => ({ id: p.id, title: p.title })),
      }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows[0] as any).posts).toHaveLength(2);
    expect((rows[1] as any).posts).toHaveLength(1);
  });

  it("where + select filters to published posts with author", async () => {
    const rows = await Post.query()
      .where((p: any) => p.published === true)
      .select((p: any) => ({ id: p.id, title: p.title, author: p.author }))
      .toArray();

    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.author != null)).toBe(true);
  });
});

// ─── relation-where (JOIN / EXISTS) ───────────────────────────────────────────

describe("relation-where: JOIN and EXISTS filtering", () => {
  const Company    = Entity("companies",  { id: "integer primary key autoincrement", name: "text not null" });
  const Category   = Entity("categories", { id: "integer primary key autoincrement", name: "text not null" });
  const Contact    = Entity(
    "contacts",
    { id: "integer primary key autoincrement", name: "text not null", email: "text", companyId: "integer not null", categoryId: "integer" },
    {
      company:  rel.manyToOne(() => Company,  { foreignKey: "companyId" }),
      category: rel.manyToOne(() => Category, { foreignKey: "categoryId" }),
    }
  );
  const Employee   = Entity("employees",  { id: "integer primary key autoincrement", name: "text not null", departmentId: "integer not null" });
  const Department = Entity(
    "departments",
    { id: "integer primary key autoincrement", name: "text not null" },
    { employees: rel.oneToMany(() => Employee, { foreignKey: "departmentId" }) }
  );

  let db: Db;
  beforeEach(async () => {
    clearRegistry();
    for (const e of [Company, Category, Contact, Employee, Department]) registerEntity(e);
    db = freshDb();
    await db.migrate();

    const acme   = await Company.query().insert({ name: "Acme Corp" });
    const globex = await Company.query().insert({ name: "Globex" });
    const sales  = await Category.query().insert({ name: "Sales" });
    const eng    = await Category.query().insert({ name: "Engineering" });
    await Contact.query().insert({ name: "John Doe",   email: "john@acme.com",  companyId: (acme as any).id,   categoryId: (sales as any).id });
    await Contact.query().insert({ name: "Jane Smith", email: "jane@acme.com",  companyId: (acme as any).id,   categoryId: (eng as any).id });
    await Contact.query().insert({ name: "Bob Wilson", email: "bob@globex.com", companyId: (globex as any).id, categoryId: (sales as any).id });

    const engDept   = await Department.query().insert({ name: "Engineering" });
    const salesDept = await Department.query().insert({ name: "Sales" });
    await Employee.query().insert({ name: "Alice", departmentId: (engDept as any).id });
    await Employee.query().insert({ name: "Bob",   departmentId: (engDept as any).id });
    await Employee.query().insert({ name: "Carol", departmentId: (salesDept as any).id });
  });
  afterEach(async () => { await db.close(); });

  it("where with relation (JOIN): contacts at Acme Corp", async () => {
    const rows = await Contact.query()
      .where((c: any) => c.company.name === "Acme Corp")
      .select((c: any) => ({ id: c.id, name: c.name }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows[0] as any).name).toBe("John Doe");
    expect((rows[1] as any).name).toBe("Jane Smith");
  });

  it("where + select same relation (JOIN reuse)", async () => {
    const rows = await Contact.query()
      .where((c: any) => c.company.name === "Acme Corp")
      .select((c: any) => ({ id: c.id, name: c.name, company: { id: c.company.id, name: c.company.name } }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows[0] as any).company.name).toBe("Acme Corp");
  });

  it("select spread + relation: all columns plus company", async () => {
    const rows = await Contact.query()
      .select((c: any) => ({ ...c, company: c.company }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.company != null)).toBe(true);
  });

  it("where uses company, select uses category (different relations)", async () => {
    const rows = await Contact.query()
      .where((c: any) => c.company.name === "Acme Corp")
      .select((c: any) => ({ id: c.id, name: c.name, category: { id: c.category.id, name: c.category.name } }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows[0] as any).category).toBeDefined();
  });

  it("oneToMany where with some() (EXISTS): departments with Alice", async () => {
    const rows = await Department.query()
      .where((d: any) => d.employees.some((e: any) => e.name === "Alice"))
      .select((d: any) => ({ id: d.id, name: d.name }))
      .toArray();

    expect(rows).toHaveLength(1);
    expect((rows[0] as any).name).toBe("Engineering");
  });

  it("count with relation where", async () => {
    const n = await Contact.query()
      .where((c: any) => c.company.name === "Acme Corp")
      .count();

    expect(n).toBe(2);
  });
});

// ─── explicit join type hints ─────────────────────────────────────────────────

describe("explicit join type hints", () => {
  const Author = Entity("authors", {
    id: "integer primary key autoincrement",
    name: "text not null",
  });

  const Article = Entity(
    "articles",
    {
      id: "integer primary key autoincrement",
      title: "text not null",
      authorId: "integer",
    },
    { author: rel.manyToOne(() => Author, { foreignKey: "authorId" }) }
  );

  let db: Db;
  beforeEach(async () => {
    clearRegistry();
    registerEntity(Author);
    registerEntity(Article);
    db = freshDb();
    await db.migrate();
    const alice = await Author.query().insert({ name: "Alice" });
    const bob   = await Author.query().insert({ name: "Bob" });
    await Article.query().insert({ title: "Alice article",   authorId: (alice as any).id });
    await Article.query().insert({ title: "Bob article",     authorId: (bob as any).id });
    await Article.query().insert({ title: "Orphan article",  authorId: null });
  });
  afterEach(async () => { await db.close(); });

  // ── INNER JOIN ──────────────────────────────────────────────────────────────

  it("innerJoin excludes orphan rows (no matching author)", async () => {
    const rows = await Article.query()
      .innerJoin((a: any) => ({ author: a.author }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows as any[]).map((r) => r.title)).toEqual(["Alice article", "Bob article"]);
  });

  it("innerJoin with single-member syntax p => p.author", async () => {
    const rows = await Article.query()
      .innerJoin((a: any) => a.author)
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows as any[]).map((r) => r.title)).toEqual(["Alice article", "Bob article"]);
  });

  it("innerJoin + where on joined relation column", async () => {
    const rows = await Article.query()
      .innerJoin((a: any) => ({ author: a.author }))
      .where((a: any) => a.author.name === "Alice")
      .toArray();

    expect(rows).toHaveLength(1);
    expect((rows[0] as any).title).toBe("Alice article");
  });

  it("innerJoin + orderBy on joined relation column", async () => {
    const rows = await Article.query()
      .innerJoin((a: any) => ({ author: a.author }))
      .orderBy("author.name", "desc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows[0] as any).title).toBe("Bob article");
    expect((rows[1] as any).title).toBe("Alice article");
  });

  // ── LEFT JOIN ───────────────────────────────────────────────────────────────

  it("leftJoin includes orphan rows (null authorId)", async () => {
    const rows = await Article.query()
      .leftJoin((a: any) => ({ author: a.author }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(3);
  });

  it("leftJoin with single-member syntax p => p.author includes orphans", async () => {
    const rows = await Article.query()
      .leftJoin((a: any) => a.author)
      .toArray();

    expect(rows).toHaveLength(3);
  });

  it("leftJoin + count returns all rows including orphans", async () => {
    const n = await Article.query()
      .leftJoin((a: any) => ({ author: a.author }))
      .count();

    expect(n).toBe(3);
  });

  // ── CROSS JOIN ──────────────────────────────────────────────────────────────
  // SQLite supports CROSS JOIN with ON clause; it behaves like INNER JOIN
  // (the ON condition filters the cartesian product, so orphan rows are excluded).

  it("crossJoin excludes orphan rows (behaves like INNER JOIN on SQLite)", async () => {
    const rows = await Article.query()
      .crossJoin((a: any) => ({ author: a.author }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows as any[]).map((r) => r.title)).toEqual(["Alice article", "Bob article"]);
  });

  it("crossJoin with single-member syntax p => p.author excludes orphans", async () => {
    const rows = await Article.query()
      .crossJoin((a: any) => a.author)
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows as any[]).map((r) => r.title)).toEqual(["Alice article", "Bob article"]);
  });

  // ── RIGHT JOIN ──────────────────────────────────────────────────────────────
  // RIGHT JOIN returns all rows from the right table (authors).
  // The orphan article (authorId = null) has no matching author so it is
  // excluded; both authors are matched so no extra null-article rows appear.

  it("rightJoin excludes orphan rows (no matching author in right table)", async () => {
    const rows = await Article.query()
      .rightJoin((a: any) => ({ author: a.author }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows as any[]).map((r) => r.title)).toEqual(["Alice article", "Bob article"]);
  });

  it("rightJoin with single-member syntax p => p.author excludes orphan rows", async () => {
    const rows = await Article.query()
      .rightJoin((a: any) => a.author)
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(2);
    expect((rows as any[]).map((r) => r.title)).toEqual(["Alice article", "Bob article"]);
  });

  // ── FULL OUTER JOIN ─────────────────────────────────────────────────────────
  // FULL OUTER JOIN returns all rows from both tables.
  // The orphan article has no matching author so it appears with null author
  // columns; both authors are matched so no extra author-only rows appear.

  it("fullJoin includes all rows from both sides (orphan article retained)", async () => {
    const rows = await Article.query()
      .fullJoin((a: any) => ({ author: a.author }))
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(3);
    expect((rows as any[]).map((r) => r.title)).toEqual(["Alice article", "Bob article", "Orphan article"]);
  });

  it("fullJoin with single-member syntax p => p.author retains orphan article", async () => {
    const rows = await Article.query()
      .fullJoin((a: any) => a.author)
      .orderBy("id", "asc")
      .toArray();

    expect(rows).toHaveLength(3);
    expect((rows as any[]).map((r) => r.title)).toEqual(["Alice article", "Bob article", "Orphan article"]);
  });
});
