import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryBuilder } from "../../src";
import { whereColumnEq } from "../../src/orm/query-helpers.js";
import { isIrSelect, type IrNode, type IrSelect, type IrWhere } from "../../src/ir/types.js";
import { Entity } from "../../src";
import { type MockDb, createMockDb } from "../helpers.js";

const mockSchema = {
  id: "integer primary key autoincrement",
  name: "text not null",
  age: "integer",
  country: "varchar",
} as const;

// Used only in `typeof` for QueryBuilder generics (value reference for Entity()).

const MockEntity = Entity("mock", mockSchema);

function newBuilder(db: MockDb, columnNames = ["id", "name", "age"]) {
  return new QueryBuilder<typeof MockEntity, InstanceType<typeof MockEntity>>({
    tableName: "users",
    columnNames: [...columnNames, "country"],
    qe: db,
    pkColumns: ["id"],
    whereIr: null,
    whereParams: {},
    subqueryParams: {},
    orderBy: [],
    havingIr: null,
    havingParams: {},
    limitNum: null,
    offsetNum: null,
    selectIr: null,
  });
}

function where(node: IrNode, rootParam = "u"): IrWhere {
  return { node, rootParam, localParamNames: [rootParam] };
}

describe("QueryBuilder", () => {
  let db: MockDb;

  beforeEach(() => {
    db = createMockDb();
  });

  describe("where", () => {
    it("accepts IR predicate and chains", () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      const q = newBuilder(db).where(where(ir));
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("accepts arrow and parses to IR", () => {
      const q = newBuilder(db).where((u: { age: number }) => u.age > 18);
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("merges params when provided", () => {
      const q = newBuilder(db).where((u: { country: string }) => u.country === "US", {
        country: "US",
      });
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("throws when arrow cannot be parsed", () => {
      const badFn = (_u: { x: number }) => {
        return (window as unknown as { y: number }).y > 1;
      };
      expect(() => newBuilder(db).where(badFn as (u: { x: number }) => boolean)).toThrow(
        "Failed to parse arrow predicate",
      );
    });
  });

  describe("orderBy", () => {
    it("chains with default asc", () => {
      const q = newBuilder(db).orderBy("name");
      expect(q).toBeInstanceOf(QueryBuilder);
    });

    it("chains with desc", () => {
      const q = newBuilder(db).orderBy("age", "desc");
      expect(q).toBeInstanceOf(QueryBuilder);
    });
  });

  describe("clone", () => {
    it("returns a new QueryBuilder with copied state", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      const base = newBuilder(db).where(where(ir)).limit(5);
      const cloned = base.clone();
      expect(cloned).toBeInstanceOf(QueryBuilder);
      expect(cloned).not.toBe(base);
      cloned.limit(10);
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      await base.toArray();
      const [sqlBase, paramsBase] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sqlBase).toContain("LIMIT ?");
      expect(paramsBase).toContain(5);
      await cloned.toArray();
      const [sqlCloned, paramsCloned] = (db.query as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(sqlCloned).toContain("LIMIT ?");
      expect(paramsCloned).toContain(10);
    });
  });

  describe("limit / offset", () => {
    it("limit chains and returns this", () => {
      const q = newBuilder(db);
      expect(q.limit(10)).toBe(q);
    });

    it("offset chains and returns this", () => {
      const q = newBuilder(db);
      expect(q.offset(5)).toBe(q);
    });
  });

  describe("select", () => {
    it("accepts column names and returns this", () => {
      const q = newBuilder(db);
      expect(q.select(["id", "name"])).toBe(q);
    });

    it("accepts IrSelect and uses it in SQL", async () => {
      const selectIr: IrSelect = { param: "u", paths: [["id"], ["name"]] };
      await newBuilder(db).select(selectIr).toArray();
      expect(db.query).toHaveBeenCalled();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
      expect(sql).toContain('"t0"."name"');
      expect(sql).not.toContain('"t0"."age"');
    });

    it("accepts IrSelect with aliases and emits AS in SQL", async () => {
      const selectIr: IrSelect = {
        param: "u",
        paths: [["id"], ["name"]],
        aliases: ["userId", "fullName"],
      };
      await newBuilder(db).select(selectIr).toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('AS "userId"');
      expect(sql).toContain('AS "fullName"');
    });

    it("accepts IrSelect with rest and includes remaining columns", async () => {
      const selectIr: IrSelect = { param: "u", paths: [["id"]], rest: true };
      await newBuilder(db).select(selectIr).toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
      expect(sql).toContain('"t0"."name"');
      expect(sql).toContain('"t0"."age"');
    });

    it("treats plain object with param and paths as IrSelect", async () => {
      const selectIr = { param: "u", paths: [["id"]] };
      expect(isIrSelect(selectIr)).toBe(true);
      await newBuilder(db)
        .select(selectIr as IrSelect)
        .toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"t0"."id"');
    });
  });

  describe("insert", () => {
    it("builds INSERT and calls db.run", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: 1, name: "Alice", age: null, country: null },
      ]);
      await newBuilder(db).insert({ name: "Alice" });
      expect(db.run).toHaveBeenCalled();
      const [sql, params] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("INSERT");
      expect(params).toContain("Alice");
    });

    it("returns hydrated instance with id from driver", async () => {
      (db.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 42, changes: 1 });
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: 42, name: "Bob", age: null, country: null },
      ]);
      const row = await newBuilder(db).insert({ name: "Bob" });
      expect(row).toBeDefined();
      expect(row.id).toBe(42);
    });

    it("all-undefined fields falls back to DEFAULT VALUES insert", async () => {
      // With no column values, compileInsert produces DEFAULT VALUES.
      // The mock db returns lastID=1 from run() but [] from query(), so the
      // re-fetch by pk finds nothing and throws "row not found".
      await expect(
        newBuilder(db).insert({
          id: undefined,
          name: undefined,
          age: undefined,
        } as unknown as Record<string, unknown>),
      ).rejects.toThrow("insert: insert succeeded but row not found");
    });
  });

  describe("insertMany", () => {
    it("returns empty array without hitting db when given no rows", async () => {
      const result = await newBuilder(db).insertMany([]);
      expect(result).toEqual([]);
      expect(db.run).not.toHaveBeenCalled();
    });

    it("builds multi-row INSERT with RETURNING * and returns hydrated rows", async () => {
      // The mock db.query returns [] by default, so hydratedRows = [].
      const rows = await newBuilder(db).insertMany([{ name: "Alice" }, { name: "Bob" }]);
      // insertMany uses db.query (RETURNING *) not db.run
      const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("INSERT");
      expect(sql).toContain('"users"');
      expect(sql).toContain("RETURNING *");
      expect(params).toContain("Alice");
      expect(params).toContain("Bob");
      expect(rows).toEqual([]); // mock returns [] from query
    });

    it("unions columns in entity order; missing columns default to null", async () => {
      // newBuilder has columnNames: ["id", "name", "age", "country"]
      // entity order: name before age
      await newBuilder(db).insertMany([
        { age: 25 }, // age first in input — entity order must win
        { name: "Alice" },
      ]);
      const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      // columns must appear in entity order: name before age
      expect(sql.indexOf('"name"')).toBeLessThan(sql.indexOf('"age"'));
      // absent columns default to null
      expect(params).toContain(null);
    });

    it("all-undefined columns produces empty column list (INSERT ... () VALUES ())", async () => {
      // With no recognised columns, cols=[]; the query still runs against the mock.
      const rows = await newBuilder(db).insertMany([
        { name: undefined } as unknown as Record<string, unknown>,
      ]);
      expect(rows).toEqual([]);
    });
  });

  describe("toArray", () => {
    it("builds SELECT and calls db.query", async () => {
      await newBuilder(db).toArray();
      expect(db.query).toHaveBeenCalled();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("SELECT");
      expect(sql).toContain("FROM");
      expect(sql).toContain("WHERE");
    });

    it("with where IR uses parameterized SQL", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 42 },
      };
      await newBuilder(db).where(where(ir)).toArray();
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("?"), [42]);
    });
  });

  describe("first", () => {
    it("returns first row when driver returns one", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ id: 1, name: "a" }]);
      const row = await newBuilder(db).first();
      expect(row).toEqual({ id: 1, name: "a" });
    });

    it("returns undefined when no rows", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const row = await newBuilder(db).first();
      expect(row).toBeUndefined();
    });
  });

  describe("count", () => {
    it("calls driver with COUNT query", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ c: 5 }]);
      const n = await newBuilder(db).count();
      expect(n).toBe(5);
    });

    it("returns 0 when no rows", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      expect(await newBuilder(db).count()).toBe(0);
    });
  });

  describe("update", () => {
    it("calls db.run with UPDATE SQL", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      await newBuilder(db).where(where(ir)).update({ name: "Updated" });
      expect(db.run).toHaveBeenCalled();
      const [sql] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("SET");
    });
  });

  describe("delete", () => {
    it("calls db.run with DELETE SQL", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      await newBuilder(db).where(where(ir)).delete();
      expect(db.run).toHaveBeenCalled();
      const [sql] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("DELETE");
    });
  });

  describe("where().first() (pk lookup)", () => {
    function newBuilderWithPk(db: MockDb) {
      return new QueryBuilder<typeof MockEntity, InstanceType<typeof MockEntity>>({
        tableName: "users",
        columnNames: ["id", "name", "age"],
        qe: db,
        pkColumns: ["id"],
        whereIr: null,
        whereParams: {},
        subqueryParams: {},
        orderBy: [],
        havingIr: null,
        havingParams: {},
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      });
    }

    it("returns row when found", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: 1, name: "Alice", age: 30 },
      ]);
      const row = await newBuilderWithPk(db).where(whereColumnEq("id", 1)).first();
      expect(row).toEqual({ id: 1, name: "Alice", age: 30 });
    });

    it("returns undefined when not found", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const row = await newBuilderWithPk(db).where(whereColumnEq("id", 999)).first();
      expect(row).toBeUndefined();
    });
  });

  describe("where().update() (pk update)", () => {
    function newBuilderWithPk(db: MockDb) {
      return new QueryBuilder<typeof MockEntity, InstanceType<typeof MockEntity>>({
        tableName: "users",
        columnNames: ["id", "name", "age"],
        qe: db,
        pkColumns: ["id"],
        whereIr: null,
        whereParams: {},
        subqueryParams: {},
        orderBy: [],
        havingIr: null,
        havingParams: {},
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      });
    }

    it("builds UPDATE ... WHERE pk = ? SQL", async () => {
      (db.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 0, changes: 1 });
      const changes = await newBuilderWithPk(db)
        .where(whereColumnEq("id", 1))
        .update({ name: "Updated" });
      expect(changes).toBe(1);
      const [sql, params] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('UPDATE "users"');
      expect(sql).toContain('"name" = ?');
      expect(sql).toMatch(/"id"\s*=\s*\?/);
      expect(params).toEqual(["Updated", 1]);
    });

    it("returns 0 when set is empty", async () => {
      const changes = await newBuilderWithPk(db).where(whereColumnEq("id", 1)).update({});
      expect(changes).toBe(0);
      expect(db.run).not.toHaveBeenCalled();
    });
  });

  describe("where().delete() (pk delete)", () => {
    function newBuilderWithPk(db: MockDb) {
      return new QueryBuilder<typeof MockEntity, InstanceType<typeof MockEntity>>({
        tableName: "users",
        columnNames: ["id", "name", "age"],
        qe: db,
        pkColumns: ["id"],
        whereIr: null,
        whereParams: {},
        subqueryParams: {},
        orderBy: [],
        havingIr: null,
        havingParams: {},
        limitNum: null,
        offsetNum: null,
        selectIr: null,
      });
    }

    it("builds DELETE ... WHERE pk = ? SQL", async () => {
      (db.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 0, changes: 1 });
      const changes = await newBuilderWithPk(db).where(whereColumnEq("id", 5)).delete();
      expect(changes).toBe(1);
      const [sql, params] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('DELETE FROM "users"');
      expect(sql).toMatch(/"id"\s*=\s*\?/);
      expect(params).toEqual([5]);
    });
  });

  describe("patch", () => {
    it("updates and re-fetches the row", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      (db.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 0, changes: 1 });
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: 1, name: "Updated", age: 30 },
      ]);
      const row = await newBuilder(db).where(where(ir)).patch({ name: "Updated" });
      expect(row).toEqual({ id: 1, name: "Updated", age: 30 });
      expect(db.run).toHaveBeenCalled();
      expect(db.query).toHaveBeenCalled();
    });

    it("returns null when row disappears after update", async () => {
      const ir: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["id"] },
        right: { kind: "const", value: 1 },
      };
      (db.run as ReturnType<typeof vi.fn>).mockReturnValueOnce({ lastID: 0, changes: 1 });
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const row = await newBuilder(db).where(where(ir)).patch({ name: "Gone" });
      expect(row).toBeNull();
    });
  });

  describe("CTE (withCte / from)", () => {
    it("prepends WITH and reads from CTE alias", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const ageGte21: IrNode = {
        kind: "binary",
        op: ">=",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 21 },
      };
      const ageLt65: IrNode = {
        kind: "binary",
        op: "<",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 65 },
      };
      const inner = newBuilder(db).where(where(ageGte21));
      const q = newBuilder(db).withCte("adults", inner).from("adults").where(where(ageLt65));
      await q.toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toMatch(/^WITH/);
      expect(sql).toContain('"adults" AS (');
      expect(sql).toContain('FROM "adults" AS "t0"');
    });

    it("second CTE can reference the first via from(name)", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const ageGte21: IrNode = {
        kind: "binary",
        op: ">=",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 21 },
      };
      const ageLt65: IrNode = {
        kind: "binary",
        op: "<",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 65 },
      };
      const adults = newBuilder(db).where(where(ageGte21));
      const working = newBuilder(db).from("adults").where(where(ageLt65));
      const q = newBuilder(db)
        .withCte("adults", adults)
        .withCte("working", working)
        .from("working");
      await q.toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('WITH "adults" AS (');
      expect(sql).toContain('"working" AS (');
      expect(sql).toContain('FROM "adults" AS "t0"');
      expect(sql).toContain('FROM "working" AS "t0"');
    });

    it("inline from(QueryBuilder) uses a subquery in FROM without WITH", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const ageGte21: IrNode = {
        kind: "binary",
        op: ">=",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 21 },
      };
      const inner = newBuilder(db).where(where(ageGte21));
      await newBuilder(db).from(inner).toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).not.toMatch(/^WITH/);
      expect(sql).toContain("FROM (");
      expect(sql).toContain('FROM "users" AS "t0"');
    });

    it("from(name) compiles unregistered name as a FROM reference", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      await newBuilder(db).from("missing").toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('FROM "missing"');
    });

    it("unionAll produces UNION ALL in SQL", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const ageGte21: IrNode = {
        kind: "binary",
        op: ">=",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 21 },
      };
      const ageGte65: IrNode = {
        kind: "binary",
        op: ">=",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 65 },
      };
      const anchor = newBuilder(db).where(where(ageGte21));
      const recursive = newBuilder(db).where(where(ageGte65));
      await anchor.unionAll(recursive).toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("UNION ALL");
    });

    it("unionAll wraps branches that use limit in parentheses", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const anchor = newBuilder(db).limit(1);
      const other = newBuilder(db);
      await anchor.unionAll(other).toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toMatch(/\(SELECT[\s\S]+LIMIT[\s\S]+\) UNION ALL SELECT/);
    });

    it("withRecursiveCte emits WITH RECURSIVE", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const ageGte21: IrNode = {
        kind: "binary",
        op: ">=",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 21 },
      };
      const ageGte65: IrNode = {
        kind: "binary",
        op: ">=",
        left: { kind: "member", param: "u", path: ["age"] },
        right: { kind: "const", value: 65 },
      };
      const anchor = newBuilder(db).where(where(ageGte21));
      const recursive = newBuilder(db).from("tree").where(where(ageGte65));
      const body = anchor.unionAll(recursive);
      await newBuilder(db).withRecursiveCte("tree", body).from("tree").toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toMatch(/^WITH RECURSIVE/);
      expect(sql).toContain('"tree" AS (');
      expect(sql).toContain("UNION ALL");
      expect(sql).toContain('FROM "tree" AS "t0"');
    });

    it("innerJoin(entity, on) adds entity table JOIN with custom ON", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      await newBuilder(db)
        .innerJoin(MockEntity, (child, parent) => child.age === parent.age)
        .toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('INNER JOIN "mock" AS "t1" ON');
      expect(sql).toContain('"t1"."age"');
      expect(sql).toContain('"t0"."age"');
    });

    it("innerJoin(entity, on) throws a join-specific error when ON parsing fails", () => {
      expect(() =>
        newBuilder(db).innerJoin(MockEntity, function (child, parent) {
          return child.age === parent.age;
        }),
      ).toThrow("Failed to parse innerJoin ON predicate:");
    });

    it("update with CTE correlates via where and emits WITH … UPDATE … FROM", async () => {
      (db.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ changes: 1 });
      const inner = newBuilder(db).where(whereColumnEq("age", 21));
      await newBuilder(db)
        .withCte("adults", inner)
        .where(
          (u: { id: number; age: number }, ctes: { adults: { id: number } }) =>
            u.age === 30 && u.id === ctes.adults.id,
        )
        .update({ name: "Senior" });
      const [sql] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toMatch(/^WITH/);
      expect(sql).toContain("UPDATE");
      expect(sql).toContain('FROM "adults"');
      expect(sql).toContain('"adults"."id"');
    });

    it("update with SET from CTE column via lambda", async () => {
      (db.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ changes: 1 });
      const inner = newBuilder(db).where(whereColumnEq("age", 21));
      await newBuilder(db)
        .withCte("adults", inner)
        .where((u: { id: number }, ctes: { adults: { name: string } }) => u.id === ctes.adults.id)
        .update((u: { name: string }, ctes: { adults: { name: string } }) => ({
          name: ctes.adults.name,
        }));
      const [sql] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"name" = "adults"."name"');
    });

    it("update with SET from entity column via lambda", async () => {
      (db.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ changes: 1 });
      await newBuilder(db)
        .where(whereColumnEq("id", 1))
        .update((u: { name: string }) => ({ name: u.name }));
      const [sql] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"name" = "t0"."name"');
    });

    it("update with empty SET and CTE in where does not run SQL", async () => {
      const inner = newBuilder(db).where(whereColumnEq("age", 21));
      const changes = await newBuilder(db)
        .withCte("adults", inner)
        .where((u: { id: number }, ctes: { adults: { id: number } }) => u.id === ctes.adults.id)
        .update({});
      expect(changes).toBe(0);
      expect(db.run).not.toHaveBeenCalled();
    });

    it("withCte throws when CTE name matches a relation key", () => {
      const inner = newBuilder(db).where(whereColumnEq("age", 21));
      const q = new QueryBuilder({
        tableName: "users",
        columnNames: ["id", "name", "age", "country"],
        qe: db,
        pkColumns: ["id"],
        whereIr: null,
        whereParams: {},
        subqueryParams: {},
        orderBy: [],
        havingIr: null,
        havingParams: {},
        limitNum: null,
        offsetNum: null,
        selectIr: null,
        relations: {
          adults: {
            _relType: "one-to-many",
            _target: () => ({}),
            _options: { foreignKey: "userId" },
          },
        } as never,
      });
      expect(() => q.withCte("adults", inner)).toThrow(
        'CTE name "adults" conflicts with relation "adults"',
      );
    });

    it("update throws after from(cteName) on a SELECT chain", async () => {
      const inner = newBuilder(db).where(whereColumnEq("age", 21));
      await expect(
        newBuilder(db).withCte("adults", inner).from("adults").update({ name: "Senior" }),
      ).rejects.toThrow("update cannot run after .from(cteName)");
    });

    it("withCte callback sets inScopeRegisteredCteNames; two-arg where correlates base table to CTE", async () => {
      (db.query as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);
      const adults = newBuilder(db).where(whereColumnEq("age", 21));
      const ukBody = newBuilder(db);
      await newBuilder(db)
        .withCte("adults", adults)
        .withCte("uk_adults", (_ctes) =>
          ukBody.where(
            (u: { id: number; country: string }, ctes: { adults: { id: number } }) =>
              u.id === ctes.adults.id && u.country === "UK",
          ),
        )
        .from("uk_adults")
        .toArray();
      const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain('"uk_adults" AS (');
      expect(sql).toContain('FROM "users" AS "t0", "adults"');
      expect(sql).toContain('"adults"."id"');
    });

    it("delete with CTE correlates via where and emits WITH … DELETE … EXISTS", async () => {
      (db.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ changes: 1 });
      const inner = newBuilder(db).where(whereColumnEq("age", 21));
      await newBuilder(db)
        .withCte("adults", inner)
        .where(
          (u: { id: number; age: number }, ctes: { adults: { id: number } }) =>
            u.age === 30 && u.id === ctes.adults.id,
        )
        .delete();
      const [sql] = (db.run as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toMatch(/^WITH/);
      expect(sql).toContain("DELETE");
      expect(sql).toContain('FROM "adults"');
      expect(sql).toContain("EXISTS");
    });

    it("delete throws after from(cteName) on a SELECT chain", async () => {
      const inner = newBuilder(db).where(whereColumnEq("age", 21));
      await expect(newBuilder(db).withCte("adults", inner).from("adults").delete()).rejects.toThrow(
        "delete cannot run after .from(cteName)",
      );
    });
  });
});
