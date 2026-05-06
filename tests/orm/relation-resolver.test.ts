import { describe, it, expect } from "vitest";
import { QueryPlanBuilder } from "../../src/orm/helpers/query-plan/query-plan.js";
import type {
  JoinedProjection,
  RelationFetchMetadata,
} from "../../src/orm/helpers/query-plan/query-plan.js";
import {
  assembleFetched,
  assembleJoined,
} from "../../src/orm/helpers/relations/relation-assembler.js";
import type { IrSelect, IrNode } from "../../src/ir/types.js";
import type { QueryState } from "../../src/orm/query-builder.js";
import type { QueryExecutor } from "../../src/orm/db.js";

const mockRelations = {
  company: {
    _relType: "many-to-one",
    _target: () => ({}),
    _options: { foreignKey: "companyId" },
  },
} as any;

// Relations whose target has a query() method — needed for fetches to be created
const mockRelationsWithTarget = {
  company: {
    _relType: "many-to-one",
    _target: () => ({ query: () => ({}), table: { _table: "companies" } }),
    _options: { foreignKey: "companyId" },
  },
} as any;

const mockRelationsToMany = {
  posts: {
    _relType: "one-to-many",
    _target: () => ({ query: () => ({}), table: { _table: "posts" } }),
    _options: { foreignKey: "userId" },
  },
} as any;

// A WHERE IR that references company.name — makes getReusableJoinKeys produce {"company"}
// when the select also references company and rootParam is "c".
const companyJoinWhereIr: IrNode = {
  kind: "binary",
  op: "===",
  left: { kind: "member", param: "c", path: ["company", "name"] },
  right: { kind: "const", value: "Acme" },
};

function makeQe(): QueryExecutor {
  return {
    dialect: "sqlite",
    query: async () => [],
    run: async () => ({ lastID: 1, changes: 0 }),
  };
}

function buildState(args: {
  selectIr: IrSelect | null;
  relations?: any;
  whereIr?: IrNode | null;
  pkColumns?: string[] | null;
}): QueryState<unknown> {
  return {
    tableName: "contacts",
    columnNames: ["id", "name", "companyId"],
    qe: makeQe(),
    pkColumns: args.pkColumns ?? ["id"],
    whereIr: args.whereIr ?? null,
    whereParams: {},
    subqueryParams: {},
    orderBy: [],
    limitNum: null,
    offsetNum: null,
    selectIr: args.selectIr,
    relations: args.relations,
    resolveRelationTarget: args.relations
      ? (rel: any) => {
          const target = rel._target();
          return target?.table ? { table: target.table._table, pk: ["id"] } : null;
        }
      : undefined,
  } as QueryState<unknown>;
}

function planFor(args: {
  selectIr: IrSelect | null;
  relations?: any;
  whereIr?: IrNode | null;
  pkColumns?: string[] | null;
}) {
  const state = buildState(args);
  return QueryPlanBuilder.build(state, { kind: "select" });
}

function makeToOneFetch(overrides: Partial<RelationFetchMetadata> = {}): RelationFetchMetadata {
  return {
    relationType: "many-to-one",
    relation: { name: "company", outputKey: "company" },
    fkColumns: ["companyId"],
    targetPkColumns: ["id"],
    targetEntity: null as any,
    ...overrides,
  };
}

function makeToManyFetch(overrides: Partial<RelationFetchMetadata> = {}): RelationFetchMetadata {
  return {
    relationType: "one-to-many",
    relation: { name: "posts", outputKey: "posts" },
    fkColumns: ["userId"],
    targetPkColumns: ["id"],
    targetEntity: null as any,
    parentPkColumns: ["id"],
    ...overrides,
  };
}

describe("relation-resolver", () => {
  describe("assembleJoined", () => {
    it("builds nested object from flat joined columns", () => {
      const rows: Record<string, unknown>[] = [
        { id: 1, name: "John", company_id: 1, company_name: "Acme" },
        { id: 2, name: "Jane", company_id: 1, company_name: "Acme" },
      ];
      const projections: JoinedProjection[] = [
        {
          relationKey: "company",
          outputKey: "company",
          members: [
            { alias: "company_id", subPath: "id" },
            { alias: "company_name", subPath: "name" },
          ],
        },
      ];
      assembleJoined(rows, projections);
      expect(rows[0].company).toEqual({ id: 1, name: "Acme" });
      expect(rows[0]).not.toHaveProperty("company_id");
      expect(rows[0]).not.toHaveProperty("company_name");
    });

    it("uses outputKey from JoinedProjection when it differs from relation name", () => {
      const rows: Record<string, unknown>[] = [
        { id: 1, name: "John", employer_id: 1, employer_name: "Acme" },
      ];
      const projections: JoinedProjection[] = [
        {
          relationKey: "company",
          outputKey: "employer",
          members: [
            { alias: "employer_id", subPath: "id" },
            { alias: "employer_name", subPath: "name" },
          ],
        },
      ];
      assembleJoined(rows, projections);
      expect(rows[0]).not.toHaveProperty("company");
      expect((rows[0] as any).employer).toEqual({ id: 1, name: "Acme" });
    });

    it("skips projection when members is empty", () => {
      const rows: Record<string, unknown>[] = [{ id: 1 }];
      const projections: JoinedProjection[] = [
        { relationKey: "company", outputKey: "company", members: [] },
      ];
      assembleJoined(rows, projections);
      expect(rows[0]).not.toHaveProperty("company");
    });
  });

  describe("assembleFetched", () => {
    it("attaches to-one relation using fkColumn lookup", () => {
      const rows: Record<string, unknown>[] = [{ id: 1, companyId: 10 }];
      const fetch = makeToOneFetch();
      const companyMap = new Map<string, unknown>([["10", { id: 10, name: "Acme" }]]);
      const fetched = new Map<string, any>([["company", companyMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].company).toEqual({ id: 10, name: "Acme" });
    });

    it("sets to-one relation to null when fk is null", () => {
      const rows: Record<string, unknown>[] = [{ id: 1, companyId: null }];
      const fetch = makeToOneFetch();
      const fetched = new Map<string, any>([["company", new Map()]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].company).toBeNull();
    });

    it("sets to-one relation to null when fk not found in fetched map", () => {
      const rows: Record<string, unknown>[] = [{ id: 1, companyId: 99 }];
      const fetch = makeToOneFetch();
      const companyMap = new Map<string, unknown>();
      const fetched = new Map<string, any>([["company", companyMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].company).toBeNull();
    });

    it("attaches to-many relation using composite PK lookup", () => {
      const rows: Record<string, unknown>[] = [{ id: 5 }];
      const fetch = makeToManyFetch();
      const postsMap = new Map<string, unknown[]>([
        [
          "5",
          [
            { id: 1, userId: 5 },
            { id: 2, userId: 5 },
          ],
        ],
      ]);
      const fetched = new Map<string, any>([["posts", postsMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].posts).toEqual([
        { id: 1, userId: 5 },
        { id: 2, userId: 5 },
      ]);
    });

    it("sets to-many to empty array when id not in fetched map", () => {
      const rows: Record<string, unknown>[] = [{ id: 7 }];
      const fetch = makeToManyFetch();
      const postsMap = new Map<unknown, unknown[]>();
      const fetched = new Map<string, any>([["posts", postsMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].posts).toEqual([]);
    });

    it("sets to-many to empty array when row has no parentPkColumn value", () => {
      const rows: Record<string, unknown>[] = [{ userId: 5 }];
      const fetch = makeToManyFetch();
      const postsMap = new Map<unknown, unknown[]>([["5", [{ id: 1 }]]]);
      const fetched = new Map<string, any>([["posts", postsMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].posts).toEqual([]);
    });

    it("sets to-many to empty array when row has neither id nor fkColumn", () => {
      const rows: Record<string, unknown>[] = [{}];
      const fetch = makeToManyFetch();
      const fetched = new Map<string, any>([["posts", new Map()]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].posts).toEqual([]);
    });

    it("skips attachment when relation is in skip set", () => {
      const rows: Record<string, unknown>[] = [{ id: 1, companyId: 10 }];
      const fetch = makeToOneFetch();
      const companyMap = new Map<unknown, unknown>([["10", { id: 10, name: "Acme" }]]);
      const fetched = new Map<string, any>([["company", companyMap]]);

      assembleFetched(rows, [fetch], fetched, new Set(["company"]));

      expect(rows[0]).not.toHaveProperty("company");
    });

    it("skips attachment when fetched has no entry for the relation", () => {
      const rows: Record<string, unknown>[] = [{ id: 1, companyId: 10 }];
      const fetch = makeToOneFetch();
      const fetched = new Map<string, any>();

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0]).not.toHaveProperty("company");
    });
  });

  describe("relation classification (via QueryPlanBuilder)", () => {
    it("includes joined relation columns in selectItems when JOIN is reusable", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["name"]],
        aliases: ["id", "name"],
        relations: [{ name: "company", outputKey: "company", subPaths: [["id"], ["name"]] }],
      };
      const plan = planFor({
        selectIr: select,
        relations: mockRelationsWithTarget,
        whereIr: companyJoinWhereIr,
      });
      const aliases = plan.selectItems.map((i) => i.alias).filter(Boolean);
      expect(aliases).toContain("company_id");
      expect(aliases).toContain("company_name");
      expect(plan.relationFetches).toHaveLength(0);
    });

    it("treats joined relation field paths as columns on the join alias", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company", "name"]],
        aliases: ["id", "company_name"],
      };
      const plan = planFor({
        selectIr: select,
        relations: mockRelationsWithTarget,
        whereIr: companyJoinWhereIr,
      });
      const aliases = plan.selectItems.map((i) => i.alias).filter(Boolean);
      expect(aliases).toContain("company_name");
      expect(plan.relationFetches).toHaveLength(0);
    });

    it("creates fetch for whole-relation path (single segment)", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company"]],
        aliases: ["id", "company"],
      };
      const plan = planFor({ selectIr: select, relations: mockRelationsWithTarget });
      expect(plan.relationFetches).toHaveLength(1);
      expect(plan.relationFetches[0].relation.name).toBe("company");
      expect(plan.relationFetches[0].relationType).toBe("many-to-one");
    });

    it("creates fetch for relation field path when not joined", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company", "name"]],
        aliases: ["id", "company_name"],
      };
      const plan = planFor({ selectIr: select, relations: mockRelationsWithTarget });
      expect(plan.relationFetches).toHaveLength(1);
      expect(plan.relationFetches[0].relation.name).toBe("company");
    });

    it("excludes relation with unsupported type from fetches", () => {
      const badRelations = {
        company: {
          _relType: "unknown-relation-kind",
          _target: () => ({ query: () => ({}), table: { _table: "companies" } }),
          _options: { foreignKey: "companyId" },
        },
      } as any;
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company"]],
        aliases: ["id", "company"],
      };
      const plan = planFor({ selectIr: select, relations: badRelations });
      expect(plan.relationFetches).toHaveLength(0);
    });

    it("returns empty selectItems when select is null", () => {
      const plan = planFor({ selectIr: null, relations: mockRelations });
      expect(plan.selectItems).toEqual([]);
      expect(plan.relationFetches).toHaveLength(0);
    });

    it("appends missing FK column when it is not already selected", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company"]],
        aliases: ["id", "company"],
      };
      const plan = planFor({ selectIr: select, relations: mockRelationsWithTarget });
      const cols = plan.selectItems
        .map((i) => (i.expr.kind === "column" ? i.expr.column[0] : null))
        .filter(Boolean);
      expect(cols).toContain("companyId");
    });

    it("does not duplicate FK column when already in selected paths", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["companyId"], ["company"]],
        aliases: ["id", "companyId", "company"],
      };
      const plan = planFor({ selectIr: select, relations: mockRelationsWithTarget });
      const companyIdCount = plan.selectItems.filter(
        (i) => i.expr.kind === "column" && i.expr.column[0] === "companyId",
      ).length;
      expect(companyIdCount).toBe(1);
    });

    it("creates fetch via select.relations when relation is not joined", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        relations: [{ name: "company", outputKey: "company", subPaths: [["id"], ["name"]] }],
      };
      const plan = planFor({ selectIr: select, relations: mockRelationsWithTarget });
      expect(plan.relationFetches).toHaveLength(1);
      expect(plan.relationFetches[0].relation.name).toBe("company");
    });

    it("deduplicates relations with same outputKey in select.relations", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        relations: [
          { name: "company", outputKey: "employer" },
          { name: "company", outputKey: "employer" },
        ],
      };
      const plan = planFor({ selectIr: select, relations: mockRelationsWithTarget });
      expect(plan.relationFetches).toHaveLength(1);
    });

    it("excludes from fetches when target entity has no query method", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["company"]],
        aliases: ["company"],
      };
      const plan = planFor({ selectIr: select, relations: mockRelations });
      expect(plan.relationFetches).toHaveLength(0);
    });

    it("appends PK column for to-many relation when not already selected", () => {
      const select: IrSelect = {
        param: "u",
        paths: [["name"], ["posts"]],
        aliases: ["name", "posts"],
      };
      const plan = planFor({ selectIr: select, relations: mockRelationsToMany });
      const cols = plan.selectItems
        .map((i) => (i.expr.kind === "column" ? i.expr.column[0] : null))
        .filter(Boolean);
      expect(cols).toContain("id");
    });

    it("does not duplicate PK column for to-many when already selected", () => {
      const select: IrSelect = {
        param: "u",
        paths: [["id"], ["posts"]],
        aliases: ["id", "posts"],
      };
      const plan = planFor({ selectIr: select, relations: mockRelationsToMany });
      const idCount = plan.selectItems.filter(
        (i) => i.expr.kind === "column" && i.expr.column[0] === "id",
      ).length;
      expect(idCount).toBe(1);
    });

    it("adds default 'id' PK column when pkColumns is null (to-many)", () => {
      const select: IrSelect = {
        param: "u",
        paths: [["name"], ["posts"]],
        aliases: ["name", "posts"],
      };
      const plan = planFor({
        selectIr: select,
        relations: mockRelationsToMany,
        pkColumns: null,
      });
      const cols = plan.selectItems
        .map((i) => (i.expr.kind === "column" ? i.expr.column[0] : null))
        .filter(Boolean);
      expect(cols).toContain("id");
    });

    it("populates skipLoadFor / joinedProjections via paths when relation is reusable from join", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company", "name"]],
        aliases: ["id", "company_name"],
      };
      const plan = planFor({
        selectIr: select,
        relations: mockRelationsWithTarget,
        whereIr: companyJoinWhereIr,
      });
      expect(plan.skipLoadFor.has("company")).toBe(true);
      expect(plan.joinedProjections.some((p) => p.relationKey === "company")).toBe(true);
    });

    it("populates skipLoadFor via select.relations when relation is reusable from join", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        relations: [{ name: "company", outputKey: "company", subPaths: [["id"], ["name"]] }],
      };
      const plan = planFor({
        selectIr: select,
        relations: mockRelationsWithTarget,
        whereIr: companyJoinWhereIr,
      });
      expect(plan.skipLoadFor.has("company")).toBe(true);
    });
  });
});
