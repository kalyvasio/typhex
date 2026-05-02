import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryBuilder } from "../../src/orm/query-builder.js";
import { Db, createSqliteDriver, Entity, rel } from "../../src/index.js";
import type { RelationDef } from "../../src/entity/relations.js";
import { sqliteDialect } from "../../src/dbs/sqlite/dialect.js";
import type { IrOrderBy } from "../../src/ir/types.js";
import { type MockDb, createMockDb } from "../helpers.js";
import { compileOrderByExpr } from "../../src/dbs/shared-dialect.js";
import type { OrderItem } from "../../src/orm/expr.js";

// ---------------------------------------------------------------------------
// Unit tests: orderBy lambda parsing
// ---------------------------------------------------------------------------

class MockCompanyE extends Entity("mock_companies", {
  id: "integer primary key",
  name: "text",
}) {}

class MockContactE extends Entity(
  "mock_contacts",
  {
    id: "integer primary key",
    name: "text",
    companyId: "integer",
  },
  {
    company: rel.manyToOne(() => MockCompanyE, { foreignKey: "companyId" }),
  },
) {}

function newBuilder(db: MockDb) {
  return new QueryBuilder<typeof MockContactE, InstanceType<typeof MockContactE>>({
    tableName: "mock_contacts",
    columnNames: ["id", "name", "companyId"],
    qe: db,
    pkColumns: ["id"],
    whereIr: null,
    whereParams: {},
    orderBy: [],
    limitNum: null,
    offsetNum: null,
    selectIr: null,
    relations: MockContactE.table._relations,
    resolveRelationTarget: (rel: RelationDef) => {
      const target = rel._target() as { table?: { _table: string } } | null;
      return target?.table ? { table: target.table._table, pk: ["id"] } : null;
    },
  });
}

describe("orderBy — lambda and dot-notation support", () => {
  let db: MockDb;

  beforeEach(() => {
    db = createMockDb();
  });

  describe("lambda parsing", () => {
    it("parses u => u.name as single-segment path", () => {
      const q = newBuilder(db);
      q.orderBy((u) => u.name);
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("parses u => u.company.name as two-segment path", () => {
      const q = newBuilder(db);
      q.orderBy((u) => u.company.name);
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("stores correct path for u => u.name", async () => {
      let capturedSql = "";
      (db.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        capturedSql = sql;
        return [];
      });
      const q = newBuilder(db);
      q.orderBy((u) => u.name);
      await q.toArray();
      expect(capturedSql).toContain('"name"');
    });

    it("throws on non-member-expression lambda", () => {
      const q = newBuilder(db);
      expect(() => q.orderBy((u) => (u.name as any) > 5)).toThrow();
    });

    it("chains and returns this (same reference)", () => {
      const q = newBuilder(db);
      const result = q.orderBy((u) => u.name);
      expect(result).toBe(q);
    });
  });

  describe("dot-notation string", () => {
    it("splits 'company.name' into path ['company', 'name']", async () => {
      let capturedSql = "";
      (db.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        capturedSql = sql;
        return [];
      });
      const q = newBuilder(db);
      q.orderBy("company.name");
      await q.toArray();
      expect(capturedSql).toContain('"mock_companies"');
      expect(capturedSql).toMatch(/ORDER BY\s+.+name/i);
    });

    it("chains and returns this (same reference)", () => {
      const q = newBuilder(db);
      const result = q.orderBy("name", "desc");
      expect(result).toBe(q);
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests: compileOrderBy with relationPathToAlias
// ---------------------------------------------------------------------------

describe("compileOrderByExpr — relation path resolution", () => {
  // Note: relation alias resolution happens in QueryPlanBuilder, not the dialect.
  // These tests now verify dialect-level rendering of pre-resolved ExprColumn.
  it("renders relation alias for column { alias: 't1', column: 'name' }", () => {
    const orders: OrderItem[] = [
      { expr: { kind: "column", alias: "t1", column: "name" }, direction: "asc" },
    ];
    const result = compileOrderByExpr(orders, sqliteDialect);
    expect(result.sql).toBe('"t1"."name" ASC');
  });

  it("renders relation alias for desc direction", () => {
    const orders: OrderItem[] = [
      { expr: { kind: "column", alias: "t1", column: "name" }, direction: "desc" },
    ];
    const result = compileOrderByExpr(orders, sqliteDialect);
    expect(result.sql).toBe('"t1"."name" DESC');
  });

  it("renders main-table alias when no relation rewrite", () => {
    const orders: OrderItem[] = [
      { expr: { kind: "column", alias: "t0", column: "name" }, direction: "asc" },
    ];
    const result = compileOrderByExpr(orders, sqliteDialect);
    expect(result.sql).toBe('"t0"."name" ASC');
  });

  it("single-segment relation-name path stays on main table", () => {
    // Planner with minPathLenForRewrite=2 keeps `u.company` (length 1 after param)
    // on the main alias. Mimic the planner's resolved output here.
    const orders: OrderItem[] = [
      { expr: { kind: "column", alias: "t0", column: "company" }, direction: "asc" },
    ];
    const result = compileOrderByExpr(orders, sqliteDialect);
    expect(result.sql).toBe('"t0"."company" ASC');
  });

  it("compiles multiple orders including a relation column", () => {
    const orders: OrderItem[] = [
      { expr: { kind: "column", alias: "t1", column: "name" }, direction: "asc" },
      { expr: { kind: "column", alias: "t0", column: "name" }, direction: "desc" },
    ];
    const result = compileOrderByExpr(orders, sqliteDialect);
    expect(result.sql).toBe('"t1"."name" ASC, "t0"."name" DESC');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: orderBy on relation columns with actual SQLite DB
// ---------------------------------------------------------------------------

class CompanyE extends Entity("companies_ob", {
  id: "integer primary key autoincrement",
  name: "text not null",
}) {}

class ContactE extends Entity(
  "contacts_ob",
  {
    id: "integer primary key autoincrement",
    name: "text not null",
    companyId: "integer not null",
  },
  {
    company: rel.manyToOne(() => CompanyE, { foreignKey: "companyId" }),
  },
) {}

describe("orderBy relation columns — integration", () => {
  let db: Db;

  beforeEach(async () => {
    db = new Db(createSqliteDriver({ path: ":memory:" }));
    await db.migrate();
    // Insert in non-alphabetical order to verify sorting
    const globex = await CompanyE.query().insert({ name: "Globex" });
    const acme = await CompanyE.query().insert({ name: "Acme" });
    await ContactE.query().insert({ name: "Bob", companyId: globex.id });
    await ContactE.query().insert({ name: "Alice", companyId: acme.id });
    await ContactE.query().insert({ name: "Charlie", companyId: globex.id });
  });

  afterEach(async () => {
    await db.close();
  });

  it("orderBy string 'company.name' asc sorts by joined relation column", async () => {
    const rows = await ContactE.query()
      .orderBy("company.name", "asc")
      .select((c) => ({ id: c.id, name: c.name }))
      .toArray();
    // Acme contacts first, then Globex
    const names = rows.map((r) => r.name);
    const aliceIdx = names.indexOf("Alice");
    const bobIdx = names.indexOf("Bob");
    const charlieIdx = names.indexOf("Charlie");
    // Alice (Acme) should come before Bob/Charlie (Globex)
    expect(aliceIdx).toBeLessThan(bobIdx);
    expect(aliceIdx).toBeLessThan(charlieIdx);
  });

  it("orderBy lambda (u => u.company.name) asc sorts by joined relation column", async () => {
    const rows = await ContactE.query()
      .orderBy((u) => u.company.name, "asc")
      .select((c) => ({ id: c.id, name: c.name }))
      .toArray();
    const names = rows.map((r) => r.name);
    const aliceIdx = names.indexOf("Alice");
    const bobIdx = names.indexOf("Bob");
    const charlieIdx = names.indexOf("Charlie");
    expect(aliceIdx).toBeLessThan(bobIdx);
    expect(aliceIdx).toBeLessThan(charlieIdx);
  });

  it("orderBy lambda desc sorts in reverse", async () => {
    const rows = await ContactE.query()
      .orderBy((u) => u.company.name, "desc")
      .select((c) => ({ id: c.id, name: c.name }))
      .toArray();
    const names = rows.map((r) => r.name);
    const aliceIdx = names.indexOf("Alice");
    const bobIdx = names.indexOf("Bob");
    // Globex first in desc, Alice (Acme) should be last
    expect(bobIdx).toBeLessThan(aliceIdx);
  });

  it("generates LEFT JOIN in SQL for relation orderBy", async () => {
    let capturedSql = "";
    const mockDb = createMockDb();
    (mockDb.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      capturedSql = sql;
      return [];
    });

    const state = {
      tableName: "contacts_ob",
      columnNames: ["id", "name", "companyId"],
      qe: mockDb,
      pkColumns: ["id"],
      whereIr: null,
      whereParams: {},
      orderBy: [] as IrOrderBy[],
      limitNum: null,
      offsetNum: null,
      selectIr: null,
      relations: ContactE.table._relations,
      resolveRelationTarget: (rel: RelationDef) => {
        const target = rel._target() as { table?: { _table: string } } | null;
        return target?.table ? { table: target.table._table, pk: ["id"] } : null;
      },
    };
    const qb = new QueryBuilder(state);
    qb.orderBy("company.name", "asc");
    await qb.toArray();
    expect(capturedSql).toContain("LEFT JOIN");
    expect(capturedSql).toContain('"companies_ob"');
    expect(capturedSql).toContain("ORDER BY");
  });
});
