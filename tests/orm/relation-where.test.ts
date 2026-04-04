import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {Db, createSqliteDriver, Entity, rel, IrNode} from "../../src/index.js";
import {clearRegistry, registerEntity} from "../../src/entity/global-driver.js";

// Entities for multi-relation JOIN tests
const User = Entity("users", {
  id: "integer primary key autoincrement",
  name: "text not null",
});

const Category = Entity("categories", {
  id: "integer primary key autoincrement",
  name: "text not null",
});

const Post = Entity("posts", {
  id: "integer primary key autoincrement",
  title: "text not null",
  authorId: "integer",
  categoryId: "integer",
}, {
  author: rel.manyToOne(() => User, { foreignKey: "authorId" }),
  category: rel.manyToOne(() => Category, { foreignKey: "categoryId" }),
});

describe("relation where (JOIN)", () => {
    let db: Db;
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
    beforeEach(async () => {
        clearRegistry();
        registerEntity(Company);
        registerEntity(Contact);
        registerEntity(Employee);
        registerEntity(Department);
        db = new Db(createSqliteDriver({ path: ":memory:" }));
        await db.migrate();
        const acme = await Company.query().insert({ name: "Acme Corp" });
        await Contact.query().insert({ name: "John", email: "j@acme.com", companyId: acme.id });
        await Contact.query().insert({ name: "Jane", email: "jane@acme.com", companyId: acme.id });
        const globex = await Company.query().insert({ name: "Globex" });
        await Contact.query().insert({ name: "Bob", email: "bob@globex.com", companyId: globex.id });
    });

    afterEach(async () => {
        await db.close();
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

describe("NOT IN / negated .some() (NOT EXISTS)", () => {
    const User = Entity(
        "rw_users",
        {
            id: "integer primary key autoincrement",
            name: "text not null",
            email: "text",
        },
        {
            posts: rel.oneToMany(() => Post, { foreignKey: "authorId" }),
        }
    );

    const Post = Entity(
        "rw_posts",
        {
            id: "integer primary key autoincrement",
            title: "text not null",
            body: "text",
            authorId: "integer not null",
            published: "boolean",
        },
        {
            author: rel.manyToOne(() => User, { foreignKey: "authorId" }),
        }
    );

    let db: Db;

    beforeEach(async () => {
        clearRegistry();
        registerEntity(User);
        registerEntity(Post);
        db = new Db(createSqliteDriver({ path: ":memory:" }));
        await db.migrate();
    });

    afterEach(async () => {
        await db.close();
    });

    describe("NOT IN with array literal via IrNode", () => {
        it("returns rows whose id is NOT IN the given list", async () => {
            const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
            const bob = await User.query().insert({ name: "Bob", email: "bob@example.com" });
            await User.query().insert({ name: "Carol", email: "carol@example.com" });

            const aliceId = (alice as any).id as number;
            const bobId = (bob as any).id as number;

            // Build IrIn with negated: true directly
            const notInIr: IrNode = {
                kind: "in",
                negated: true,
                left: { kind: "member", param: "u", path: ["id"] },
                right: { kind: "const", value: [aliceId, bobId] },
            };

            const results = await User.query()
                .where(notInIr)
                .orderBy("id", "asc")
                .toArray();

            expect(results).toHaveLength(1);
            expect((results[0] as any).name).toBe("Carol");
        });

        it("NOT IN with empty array (negated: true) returns all rows (1=1)", async () => {
            await User.query().insert({ name: "Alice", email: "alice@example.com" });
            await User.query().insert({ name: "Bob", email: "bob@example.com" });

            // IrIn with negated: true and empty list compiles to 1=1 — all rows match
            const notInEmptyIr: IrNode = {
                kind: "in",
                negated: true,
                left: { kind: "member", param: "u", path: ["id"] },
                right: { kind: "const", value: [] },
            };

            const results = await User.query()
                .where(notInEmptyIr)
                .orderBy("id", "asc")
                .toArray();

            expect(results).toHaveLength(2);
        });

        it("IN with empty array (negated: false) returns no rows (1=0)", async () => {
            await User.query().insert({ name: "Alice", email: "alice@example.com" });

            // IrIn without negation and empty list compiles to 1=0 — no rows match
            const inEmptyIr: IrNode = {
                kind: "in",
                left: { kind: "member", param: "u", path: ["id"] },
                right: { kind: "const", value: [] },
            };

            const results = await User.query()
                .where(inEmptyIr)
                .toArray();

            expect(results).toHaveLength(0);
        });

        it("parses !(u.id in [1, 2, 3]) arrow to negated IrIn and executes correctly", async () => {
            // Use fixed IDs so we can reference them as literals in the arrow body.
            // SQLite autoincrement starts at 1, so insert order gives predictable IDs.
            await User.query().insert({ name: "Alice", email: "alice@example.com" }); // id=1
            await User.query().insert({ name: "Bob", email: "bob@example.com" });     // id=2
            await User.query().insert({ name: "Carol", email: "carol@example.com" }); // id=3

            // Arrow with literal array values — these parse as IrConst, no closure needed
            const results = await User.query()
                .where((u: any) => !(u.id in [1, 2]))
                .orderBy("id", "asc")
                .toArray();

            // Only Carol (id=3) should be returned
            expect(results).toHaveLength(1);
            expect((results[0] as any).name).toBe("Carol");
        });
    });

    describe("!.some() compiles to NOT EXISTS (unary wrapping)", () => {
        it("negated .some() returns users with no published posts", async () => {
            const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
            await User.query().insert({ name: "Bob", email: "bob@example.com" });

            // Alice has a published post; Bob has none
            await Post.query().insert({ title: "Hello", authorId: (alice as any).id, published: true });

            const results = await User.query()
                .where((u: any) => !u.posts.some((p: any) => p.published === true))
                .orderBy("id", "asc")
                .toArray();

            expect(results).toHaveLength(1);
            expect((results[0] as any).name).toBe("Bob");
        });
    });

    describe(".every() compiles to NOT EXISTS with negated inner predicate", () => {
        it("returns users where all posts are published", async () => {
            const alice = await User.query().insert({ name: "Alice", email: "alice@example.com" });
            const bob = await User.query().insert({ name: "Bob", email: "bob@example.com" });

            // Alice: all published; Bob: one published, one not
            await Post.query().insert({ title: "A1", authorId: (alice as any).id, published: true });
            await Post.query().insert({ title: "A2", authorId: (alice as any).id, published: true });
            await Post.query().insert({ title: "B1", authorId: (bob as any).id, published: true });
            await Post.query().insert({ title: "B2", authorId: (bob as any).id, published: false });

            const results = await User.query()
                .where((u: any) => u.posts.every((p: any) => p.published === true))
                .orderBy("id", "asc")
                .toArray();

            expect(results).toHaveLength(1);
            expect((results[0] as any).name).toBe("Alice");
        });

        it("vacuously includes users with no posts", async () => {
            await User.query().insert({ name: "Alice", email: "alice@example.com" });
            // Alice has no posts — every() is vacuously true

            const results = await User.query()
                .where((u: any) => u.posts.every((p: any) => p.published === true))
                .toArray();

            expect(results).toHaveLength(1);
            expect((results[0] as any).name).toBe("Alice");
        });
    });
});

describe("relation where — NULL FK and negated filters", () => {
  let db: Db;

  beforeEach(async () => {
    clearRegistry();
    registerEntity(User);
    registerEntity(Category);
    registerEntity(Post);
    db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.migrate();
  });

  it("excludes rows with null FK when filtering by relation property", async () => {
    await Post.query().insert({ title: "orphan", authorId: null as any });
    const results = await Post.query()
      .where((p: any) => p.author.name === "Alice")
      .toArray();
    expect(results).toHaveLength(0);
  });

  it("filters by negated relation property", async () => {
    const alice = await User.query().insert({ name: "Alice" });
    const bob = await User.query().insert({ name: "Bob" });
    await Post.query().insert({ title: "Alice post", authorId: (alice as any).id });
    await Post.query().insert({ title: "Bob post", authorId: (bob as any).id });

    const results = await Post.query()
      .where((p: any) => p.author.name !== "Alice")
      .toArray();
    expect(results).toHaveLength(1);
    expect((results[0] as any).title).toBe("Bob post");
  });

  it("handles multiple concurrent many-to-one joins in one where()", async () => {
    const alice = await User.query().insert({ name: "Alice" });
    const sci = await Category.query().insert({ name: "Science" });
    const art = await Category.query().insert({ name: "Art" });
    await Post.query().insert({ title: "Alice Science", authorId: (alice as any).id, categoryId: (sci as any).id });
    await Post.query().insert({ title: "Alice Art", authorId: (alice as any).id, categoryId: (art as any).id });

    const results = await Post.query()
      .where((p: any) => p.author.name === "Alice" && p.category.name === "Science")
      .toArray();
    expect(results).toHaveLength(1);
    expect((results[0] as any).title).toBe("Alice Science");
  });

  it("handles null FK with negated relation filter (null rows excluded)", async () => {
    await Post.query().insert({ title: "no author", authorId: null as any });
    const results = await Post.query()
      .where((p: any) => p.author.name !== "Alice")
      .toArray();
    // NULL FK: LEFT JOIN gives NULL for author.name
    // NULL <> "Alice" is NULL (unknown) in SQL → row excluded
    expect(results).toHaveLength(0);
  });
});
