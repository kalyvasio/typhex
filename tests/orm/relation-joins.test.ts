import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRelationJoins, buildRelationPathToAlias, buildOneToManyExists, getReusableJoinKeys } from "../../src/orm/relation-joins.js";
import type { IrNode, IrOrderBy, IrSelect, JoinType } from "../../src/ir/types.js";
import type { RelationsMap } from "../../src/entity/relations.js";

const mockResolveTarget = vi.fn(() => ({ table: "companies", pk: ["id"] }));

const mockRelations: RelationsMap = {
  company: {
    _relType: "many-to-one",
    _target: () => ({}),
    _options: { foreignKey: "companyId" },
  } as any,
  employees: {
    _relType: "one-to-many",
    _target: () => ({}),
    _options: { foreignKey: "departmentId" },
  } as any,
};

const ctx = {
  relations: mockRelations,
  tableName: "contacts",
  columnNames: ["id", "name", "companyId"],
  pkColumns: ["id"],
  resolveTarget: mockResolveTarget,
};

describe("relation-joins", () => {
  beforeEach(() => {
    mockResolveTarget.mockReturnValue({ table: "companies", pk: ["id"] });
  });

  describe("buildRelationJoins", () => {
    it("returns empty when no relations in where or select", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["name"] },
        right: { kind: "const", value: "Alice" },
      };
      const result = buildRelationJoins(ctx, where, "c");
      expect(result).toEqual([]);
    });

    it("returns join info when relation in where", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const result = buildRelationJoins(ctx, where, "c");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        relationKey: "company",
        targetTable: "companies",
        targetPkColumns: ["id"],
        foreignKeys: ["companyId"],
        relType: "many-to-one",
      });
      expect(result[0].alias).toMatch(/^t\d+$/);
    });

    it("returns empty when relation only in select paths (select-only uses whereIn)", () => {
      const result = buildRelationJoins(ctx, null, "c");
      expect(result).toEqual([]);
    });

    it("returns empty when relation only in select.relations (select-only uses whereIn)", () => {
      const result = buildRelationJoins(ctx, null, "c");
      expect(result).toEqual([]);
    });

    it("does not add one-to-many to joins (uses EXISTS instead)", () => {
      mockResolveTarget.mockReturnValue({ table: "employees", pk: ["id"] });
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "d", path: ["employees", "name"] },
        right: { kind: "const", value: "Alice" },
      };
      const result = buildRelationJoins(ctx, where, "d");
      expect(result).toHaveLength(0);
      mockResolveTarget.mockReturnValue({ table: "companies", pk: ["id"] });
    });

    it("returns join when relation referenced in where (joins are driven by where/orderBy, not select IR)", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const result = buildRelationJoins(ctx, where, "c");
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("collects relation key from unary (NOT) operand", () => {
      const where: IrNode = {
        kind: "unary",
        op: "!",
        operand: { kind: "member", param: "c", path: ["company", "active"] },
      };
      const result = buildRelationJoins(ctx, where, "c");
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("collects relation key from call node receiver", () => {
      const where: IrNode = {
        kind: "call",
        method: "startsWith",
        receiver: { kind: "member", param: "c", path: ["company", "name"] },
        args: [{ kind: "const", value: "Acm" }],
      };
      const result = buildRelationJoins(ctx, where, "c");
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("collects relation key from call node args", () => {
      const where: IrNode = {
        kind: "call",
        method: "includes",
        receiver: { kind: "const", value: ["Acme"] },
        args: [{ kind: "member", param: "c", path: ["company", "name"] }],
      };
      const result = buildRelationJoins(ctx, where, "c");
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("skips relations that have a junction option", () => {
      const relationsWithJunction: RelationsMap = {
        tags: {
          _relType: "many-to-one" as any,
          _target: () => ({}),
          _options: { junction: "post_tags", foreignKey: "postId" } as any,
        } as any,
      };
      const where: IrNode = {
        kind: "member",
        param: "c",
        path: ["tags", "name"],
      };
      const result = buildRelationJoins({ ...ctx, relations: relationsWithJunction }, where, "c");
      expect(result).toHaveLength(0);
    });

    it("skips relation with no foreignKey in options", () => {
      const relationsNoFk: RelationsMap = {
        company: {
          _relType: "many-to-one" as any,
          _target: () => ({}),
          _options: {} as any, // no foreignKey → fk = "" → skipped
        } as any,
      };
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const result = buildRelationJoins({ ...ctx, relations: relationsNoFk }, where, "c");
      expect(result).toHaveLength(0);
    });

    it("returns empty when resolveTarget returns null", () => {
      mockResolveTarget.mockReturnValueOnce(null);
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const result = buildRelationJoins(ctx, where, "c");
      expect(result).toEqual([]);
    });

    it("returns join when relation column used in orderBy (dot-notation path)", () => {
      const orderBy: IrOrderBy[] = [
        { param: "u", path: ["company", "name"], direction: "asc" },
      ];
      const result = buildRelationJoins(ctx, null, "u", orderBy);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        relationKey: "company",
        targetTable: "companies",
        targetPkColumns: ["id"],
        foreignKeys: ["companyId"],
        relType: "many-to-one",
      });
    });

    it("returns empty when orderBy path has only one segment (not a relation column)", () => {
      const orderBy: IrOrderBy[] = [
        { param: "u", path: ["name"], direction: "asc" },
      ];
      const result = buildRelationJoins(ctx, null, "u", orderBy);
      expect(result).toEqual([]);
    });

    it("does not duplicate join when same relation in both where and orderBy", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "u", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const orderBy: IrOrderBy[] = [
        { param: "u", path: ["company", "name"], direction: "asc" },
      ];
      const result = buildRelationJoins(ctx, where, "u", orderBy);
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("does not join one-to-many relation from orderBy", () => {
      mockResolveTarget.mockReturnValue({ table: "employees", pk: ["id"] });
      const orderBy: IrOrderBy[] = [
        { param: "u", path: ["employees", "name"], direction: "asc" },
      ];
      const result = buildRelationJoins(ctx, null, "u", orderBy);
      expect(result).toHaveLength(0);
      mockResolveTarget.mockReturnValue({ table: "companies", pk: ["id"] });
    });

    it("returns empty when orderBy is undefined", () => {
      const result = buildRelationJoins(ctx, null, "u", undefined);
      expect(result).toEqual([]);
    });
  });

  describe("getReusableJoinKeys", () => {
    it("returns empty when relation only in select", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["company", "id"], ["company", "name"]],
        aliases: ["company_id", "company_name"],
      };
      const result = getReusableJoinKeys(null, select, mockRelations, "c");
      expect(result).toEqual(new Set());
    });

    it("returns relation when in both and select projection <= where projection", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const select: IrSelect = {
        param: "c",
        paths: [["company", "name"]],
        aliases: ["company_name"],
      };
      const result = getReusableJoinKeys(where, select, mockRelations, "c");
      expect(result).toEqual(new Set(["company"]));
    });

    it("returns relation when in both (where joins whole table, no projection comparison)", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const select: IrSelect = {
        param: "c",
        paths: [["company", "id"], ["company", "name"]],
        aliases: ["company_id", "company_name"],
      };
      const result = getReusableJoinKeys(where, select, mockRelations, "c");
      expect(result).toEqual(new Set(["company"]));
    });

    it("returns empty when selectNode is null", () => {
      const result = getReusableJoinKeys(null, null, mockRelations, "c");
      expect(result.size).toBe(0);
    });

    it("skips one-to-many relation (cannot be reused via join)", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "d", path: ["employees", "name"] },
        right: { kind: "const", value: "Alice" },
      };
      const select: IrSelect = {
        param: "d",
        paths: [["employees", "name"]],
        aliases: ["employees_name"],
      };
      const result = getReusableJoinKeys(where, select, mockRelations, "d");
      expect(result.has("employees")).toBe(false);
    });

    it("returns relation when in both even with whole relation in select (no subPaths)", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        relations: [{ name: "company", outputKey: "company" }],
      };
      const result = getReusableJoinKeys(where, select, mockRelations, "c");
      expect(result).toEqual(new Set(["company"]));
    });
  });

  describe("buildOneToManyExists", () => {
    it("returns EXISTS info for one-to-many relation in where", () => {
      mockResolveTarget.mockReturnValue({ table: "employees", pk: ["id"] });
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "d", path: ["employees", "name"] },
        right: { kind: "const", value: "Alice" },
      };
      const result = buildOneToManyExists(where, mockRelations, "d", ["id"], mockResolveTarget);
      expect(result["d.employees"]).toMatchObject({
        targetTable: "employees",
        fkColumns: ["departmentId"],
        mainPk: ["id"],
      });
      expect(result["d.employees"].alias).toMatch(/^ex\d+$/);
      mockResolveTarget.mockReturnValue({ table: "companies", pk: ["id"] });
    });

    it("skips junction relations in EXISTS", () => {
      const relationsWithJunction: RelationsMap = {
        tags: {
          _relType: "one-to-many" as any,
          _target: () => ({}),
          _options: { junction: "post_tags", foreignKey: "postId" } as any,
        } as any,
      };
      mockResolveTarget.mockReturnValue({ table: "tags", pk: ["id"] });
      const where: IrNode = {
        kind: "member",
        param: "c",
        path: ["tags", "name"],
      };
      const result = buildOneToManyExists(where, relationsWithJunction, "c", ["id"], mockResolveTarget);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("skips when resolveTarget returns null for one-to-many", () => {
      mockResolveTarget.mockReturnValueOnce(null);
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "d", path: ["employees", "name"] },
        right: { kind: "const", value: "Alice" },
      };
      const result = buildOneToManyExists(where, mockRelations, "d", ["id"], mockResolveTarget);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("skips one-to-many with no foreignKey in options", () => {
      const relNoFk: RelationsMap = {
        posts: {
          _relType: "one-to-many" as any,
          _target: () => ({}),
          _options: {} as any,
        } as any,
      };
      mockResolveTarget.mockReturnValue({ table: "posts", pk: ["id"] });
      const where: IrNode = {
        kind: "member",
        param: "u",
        path: ["posts", "title"],
      };
      const result = buildOneToManyExists(where, relNoFk, "u", ["id"], mockResolveTarget);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("returns empty when no one-to-many in where", () => {
      const where: IrNode = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const result = buildOneToManyExists(where, mockRelations, "c", ["id"], mockResolveTarget);
      expect(result).toEqual({});
    });
  });

  describe("buildRelationPathToAlias", () => {
    it("maps param.relationKey to join alias", () => {
      const joins = [
        {
          relationKey: "company",
          alias: "t1",
          targetTable: "companies",
          targetPkColumns: ["id"],
          foreignKeys: ["companyId"],
          joinType: 'left' as JoinType,
          relType: "many-to-one" as const,
        },
      ];
      const map = buildRelationPathToAlias(joins, ["c"]);
      expect(map["c.company"]).toBe("t1");
    });

    it("returns empty when no joins", () => {
      const map = buildRelationPathToAlias([], ["c"]);
      expect(map).toEqual({});
    });
  });
});
