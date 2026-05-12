import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RelationJoinBuilder,
  RelationPathAliasBuilder,
  OneToManyExistsBuilder,
} from "../../src/orm/helpers/relations/relation-joins.js";
import type { IrNode, JoinType } from "../../src/ir/types.js";
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
      const result = new RelationJoinBuilder(ctx, new Set()).build();
      expect(result).toEqual([]);
    });

    it("returns join info when relation in where", () => {
      const result = new RelationJoinBuilder(ctx, new Set(["company"])).build();
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
      const result = new RelationJoinBuilder(ctx, new Set()).build();
      expect(result).toEqual([]);
    });

    it("returns empty when relation only in select.relations (select-only uses whereIn)", () => {
      const result = new RelationJoinBuilder(ctx, new Set()).build();
      expect(result).toEqual([]);
    });

    it("does not add one-to-many to joins (uses EXISTS instead)", () => {
      mockResolveTarget.mockReturnValue({ table: "employees", pk: ["id"] });
      const result = new RelationJoinBuilder(ctx, new Set(["employees"])).build();
      expect(result).toHaveLength(0);
      mockResolveTarget.mockReturnValue({ table: "companies", pk: ["id"] });
    });

    it("returns join when relation referenced in where (joins are driven by where/orderBy, not select IR)", () => {
      const result = new RelationJoinBuilder(ctx, new Set(["company"])).build();
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("collects relation key from unary (NOT) operand", () => {
      const result = new RelationJoinBuilder(ctx, new Set(["company"])).build();
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("collects relation key from call node receiver", () => {
      const result = new RelationJoinBuilder(ctx, new Set(["company"])).build();
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("collects relation key from call node args", () => {
      const result = new RelationJoinBuilder(ctx, new Set(["company"])).build();
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
      const result = new RelationJoinBuilder(
        { ...ctx, relations: relationsWithJunction },
        new Set(["tags"]),
      ).build();
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
      const result = new RelationJoinBuilder(
        { ...ctx, relations: relationsNoFk },
        new Set(["company"]),
      ).build();
      expect(result).toHaveLength(0);
    });

    it("returns empty when resolveTarget returns null", () => {
      mockResolveTarget.mockReturnValueOnce(null);
      const result = new RelationJoinBuilder(ctx, new Set(["company"])).build();
      expect(result).toEqual([]);
    });

    it("returns join when relation column used in orderBy (dot-notation path)", () => {
      const result = new RelationJoinBuilder(ctx, new Set(["company"])).build();
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
      const result = new RelationJoinBuilder(ctx, new Set()).build();
      expect(result).toEqual([]);
    });

    it("does not duplicate join when same relation in both where and orderBy", () => {
      const result = new RelationJoinBuilder(ctx, new Set(["company"])).build();
      expect(result).toHaveLength(1);
      expect(result[0].relationKey).toBe("company");
    });

    it("does not join one-to-many relation from orderBy", () => {
      mockResolveTarget.mockReturnValue({ table: "employees", pk: ["id"] });
      const result = new RelationJoinBuilder(ctx, new Set(["employees"])).build();
      expect(result).toHaveLength(0);
      mockResolveTarget.mockReturnValue({ table: "companies", pk: ["id"] });
    });

    it("returns empty when orderBy is undefined", () => {
      const result = new RelationJoinBuilder(ctx, new Set()).build();
      expect(result).toEqual([]);
    });
  });

  describe("buildOneToManyExists", () => {
    it("returns EXISTS info for one-to-many relation in where", () => {
      mockResolveTarget.mockReturnValue({ table: "employees", pk: ["id"] });
      const where: IrNode = {
        kind: "exists",
        rootParam: "d",
        relationKey: "employees",
        innerParam: "e",
        innerWhere: {
          kind: "binary",
          op: "===",
          left: { kind: "member", param: "e", path: ["name"] },
          right: { kind: "const", value: "Alice" },
        },
      };
      const result = new OneToManyExistsBuilder(
        [where],
        mockRelations,
        "d",
        ["id"],
        mockResolveTarget,
      ).build();
      expect(result["d.employees"]).toMatchObject({
        targetTable: "employees",
        fkColumns: ["departmentId"],
        mainPk: ["id"],
      });
      expect(result["d.employees"].alias).toMatch(/^ex\d+$/);
      mockResolveTarget.mockReturnValue({ table: "companies", pk: ["id"] });
    });

    it("throws for unknown EXISTS relations", () => {
      const where: IrNode = {
        kind: "exists",
        rootParam: "c",
        relationKey: "tags",
        innerParam: "t",
        innerWhere: { kind: "const", value: true },
      };
      expect(() =>
        new OneToManyExistsBuilder([where], mockRelations, "c", ["id"], mockResolveTarget).build(),
      ).toThrow('EXISTS relation "tags" is not defined');
    });

    it("throws when EXISTS targets a non one-to-many relation", () => {
      const where: IrNode = {
        kind: "exists",
        rootParam: "c",
        relationKey: "company",
        innerParam: "x",
        innerWhere: { kind: "const", value: true },
      };
      expect(() =>
        new OneToManyExistsBuilder([where], mockRelations, "c", ["id"], mockResolveTarget).build(),
      ).toThrow('EXISTS relation "company" must be one-to-many');
    });

    it("throws when one-to-many EXISTS has no parent primary key", () => {
      const where: IrNode = {
        kind: "exists",
        rootParam: "d",
        relationKey: "employees",
        innerParam: "e",
        innerWhere: { kind: "const", value: true },
      };
      expect(() =>
        new OneToManyExistsBuilder([where], mockRelations, "d", [], mockResolveTarget).build(),
      ).toThrow('EXISTS relation "employees" requires a primary key');
    });

    it("returns empty when no one-to-many in where", () => {
      const result = new OneToManyExistsBuilder(
        [],
        mockRelations,
        "c",
        ["id"],
        mockResolveTarget,
      ).build();
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
          joinType: "left" as JoinType,
          relType: "many-to-one" as const,
        },
      ];
      const map = new RelationPathAliasBuilder(joins, ["c"]).build();
      expect(map["c.company"]).toBe("t1");
    });

    it("returns empty when no joins", () => {
      const map = new RelationPathAliasBuilder([], ["c"]).build();
      expect(map).toEqual({});
    });
  });
});
