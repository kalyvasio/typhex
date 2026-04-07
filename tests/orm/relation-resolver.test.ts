import { describe, it, expect } from "vitest";
import {
  buildRelationContext,
} from "../../src/orm/relation-context-builder.js";
import type { RelationFetchMetadata } from "../../src/orm/relation-context-builder.js";
import { assembleJoined, assembleFetched } from "../../src/orm/relation-assembler.js";
import type { IrSelect } from "../../src/ir/types.js";

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
    _target: () => ({ query: () => ({}) }),
    _options: { foreignKey: "companyId" },
  },
} as any;

const mockRelationsToMany = {
  posts: {
    _relType: "one-to-many",
    _target: () => ({ query: () => ({}) }),
    _options: { foreignKey: "userId" },
  },
} as any;

// A WHERE IR that references company.name — makes getReusableJoinKeys produce {"company"}
// when the select also references company and rootParam is "c".
const companyJoinWhereIr = {
  kind: "binary", op: "===",
  left: { kind: "member", param: "c", path: ["company", "name"] },
  right: { kind: "const", value: "Acme" },
};

function makeToOneFetch(overrides: Partial<RelationFetchMetadata> = {}): RelationFetchMetadata {
  return {
    relation: { name: "company", outputKey: "company" },
    fkColumns: ["companyId"],
    targetPkColumns: ["id"],
    targetEntity: null as any,
    isArray: false,
    ...overrides,
  };
}

function makeToManyFetch(overrides: Partial<RelationFetchMetadata> = {}): RelationFetchMetadata {
  return {
    relation: { name: "posts", outputKey: "posts" },
    fkColumns: ["userId"],
    targetPkColumns: ["id"],
    targetEntity: null as any,
    isArray: true,
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
      const select: IrSelect = {
        param: "c",
        paths: [["company", "id"], ["company", "name"]],
        aliases: ["company_id", "company_name"],
      };
      assembleJoined(rows, new Set(["company"]), select);
      expect(rows[0].company).toEqual({ id: 1, name: "Acme" });
      expect(rows[0]).not.toHaveProperty("company_id");
      expect(rows[0]).not.toHaveProperty("company_name");
    });

    it("falls back to relKey_field alias when no explicit aliases provided", () => {
      const rows: Record<string, unknown>[] = [
        { id: 1, company_id: 10, company_name: "Acme" },
      ];
      const select: IrSelect = {
        param: "c",
        paths: [["company", "id"], ["company", "name"]],
        aliases: [], // empty → forces the ?? fallback inside collectJoinedSubPaths
      };
      assembleJoined(rows, new Set(["company"]), select);
      expect(rows[0].company).toEqual({ id: 10, name: "Acme" });
      expect(rows[0]).not.toHaveProperty("company_id");
      expect(rows[0]).not.toHaveProperty("company_name");
    });

    it("builds from select.relations with subPaths", () => {
      const rows: Record<string, unknown>[] = [{ id: 1, name: "John", company_id: 1, company_name: "Acme" }];
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["name"]],
        aliases: ["id", "name"],
        relations: [{ name: "company", outputKey: "company", subPaths: [["id"], ["name"]] }],
      };
      assembleJoined(rows, new Set(["company"]), select);
      expect(rows[0].company).toEqual({ id: 1, name: "Acme" });
    });

    it("uses outputKey from IrSelectRelation when it differs from relation name", () => {
      const rows: Record<string, unknown>[] = [{ id: 1, name: "John", employer_id: 1, employer_name: "Acme" }];
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["name"]],
        aliases: ["id", "name"],
        relations: [{ name: "company", outputKey: "employer", subPaths: [["id"], ["name"]] }],
      };
      assembleJoined(rows, new Set(["company"]), select);
      expect(rows[0]).not.toHaveProperty("company");
      expect((rows[0] as any).employer).toEqual({ id: 1, name: "Acme" });
    });

    it("skips relation key when no subPaths produce columns", () => {
      const rows: Record<string, unknown>[] = [{ id: 1 }];
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        // no relation paths for "company"
      };
      assembleJoined(rows, new Set(["company"]), select);
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
      const companyMap = new Map<string, unknown>(); // "99" not in map
      const fetched = new Map<string, any>([["company", companyMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].company).toBeNull();
    });

    it("attaches to-many relation using composite PK lookup", () => {
      const rows: Record<string, unknown>[] = [{ id: 5 }];
      const fetch = makeToManyFetch();
      const postsMap = new Map<string, unknown[]>([["5", [{ id: 1, userId: 5 }, { id: 2, userId: 5 }]]]);
      const fetched = new Map<string, any>([["posts", postsMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].posts).toEqual([{ id: 1, userId: 5 }, { id: 2, userId: 5 }]);
    });

    it("sets to-many to empty array when id not in fetched map", () => {
      const rows: Record<string, unknown>[] = [{ id: 7 }];
      const fetch = makeToManyFetch();
      const postsMap = new Map<unknown, unknown[]>(); // 7 not in map
      const fetched = new Map<string, any>([["posts", postsMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0].posts).toEqual([]);
    });

    it("sets to-many to empty array when row has no parentPkColumn value", () => {
      const rows: Record<string, unknown>[] = [{ userId: 5 }]; // no "id" key, parentPkColumns defaults to ["id"]
      const fetch = makeToManyFetch();
      const postsMap = new Map<unknown, unknown[]>([["5", [{ id: 1 }]]]);
      const fetched = new Map<string, any>([["posts", postsMap]]);

      assembleFetched(rows, [fetch], fetched, new Set());

      // parentPkCol = "id" (default), row["id"] = undefined → no match → empty
      expect(rows[0].posts).toEqual([]);
    });

    it("sets to-many to empty array when row has neither id nor fkColumn", () => {
      const rows: Record<string, unknown>[] = [{}]; // pk = undefined ?? undefined = undefined → null check fails
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
      const fetched = new Map<string, any>(); // no "company" entry

      assembleFetched(rows, [fetch], fetched, new Set());

      expect(rows[0]).not.toHaveProperty("company");
    });
  });

  describe("column/relation resolution (via buildRelationContext)", () => {
    it("includes relation subPaths in columnPaths when joined", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["name"]],
        aliases: ["id", "name"],
        relations: [{ name: "company", outputKey: "company", subPaths: [["id"], ["name"]] }],
      };
      const ctx = buildRelationContext(select, mockRelations, companyJoinWhereIr as any, ["id"], "c");
      expect(ctx.columnPaths).toContainEqual(["company", "id"]);
      expect(ctx.columnPaths).toContainEqual(["company", "name"]);
      expect(ctx.relationFetches).toHaveLength(0);
    });

    it("adds joined relation field paths from select.paths directly to columnPaths", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company", "name"]],
        aliases: ["id", "company_name"],
      };
      const ctx = buildRelationContext(select, mockRelations, companyJoinWhereIr as any, ["id"], "c");
      expect(ctx.columnPaths).toContainEqual(["company", "name"]);
      expect(ctx.columnAliases).toContain("company_name");
      expect(ctx.relationFetches).toHaveLength(0);
    });

    it("creates fetch for whole-relation path (single segment)", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company"]],
        aliases: ["id", "company"],
      };
      const ctx = buildRelationContext(select, mockRelationsWithTarget, null, ["id"], "c");
      expect(ctx.columnPaths).not.toContainEqual(["company"]);
      expect(ctx.relationFetches).toHaveLength(1);
      expect(ctx.relationFetches[0].relation.name).toBe("company");
      expect(ctx.relationFetches[0].isArray).toBe(false);
    });

    it("creates fetch for relation field path when not joined", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company", "name"]],
        aliases: ["id", "company_name"],
      };
      const ctx = buildRelationContext(select, mockRelationsWithTarget, null, ["id"], "c");
      expect(ctx.columnPaths).not.toContainEqual(["company", "name"]);
      expect(ctx.relationFetches).toHaveLength(1);
      expect(ctx.relationFetches[0].relation.name).toBe("company");
    });

    it("excludes relation with unsupported type from fetches", () => {
      const badRelations = {
        company: {
          _relType: "unknown-relation-kind",
          _target: () => ({ query: () => ({}) }),
          _options: { foreignKey: "companyId" },
        },
      } as any;
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company"]],
        aliases: ["id", "company"],
      };
      const ctx = buildRelationContext(select, badRelations, null, ["id"], "c");
      expect(ctx.relationFetches).toHaveLength(0);
    });

    it("returns null columnPaths when select is null", () => {
      const ctx = buildRelationContext(null, mockRelations, null, ["id"], "c");
      expect(ctx.columnPaths).toBeNull();
      expect(ctx.columnAliases).toBeNull();
      expect(ctx.relationFetches).toHaveLength(0);
    });

    it("appends missing FK column when it is not already selected", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company"]],
        aliases: ["id", "company"],
      };
      const ctx = buildRelationContext(select, mockRelationsWithTarget, null, ["id"], "c");
      // "companyId" FK must be appended so the fetched rows can be correlated
      expect(ctx.columnPaths!.some((p) => p[0] === "companyId")).toBe(true);
    });

    it("does not duplicate FK column when already in selected paths", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["companyId"], ["company"]],
        aliases: ["id", "companyId", "company"],
      };
      const ctx = buildRelationContext(select, mockRelationsWithTarget, null, ["id"], "c");
      expect(ctx.columnPaths!.filter((p) => p[0] === "companyId")).toHaveLength(1);
    });

    it("creates fetch via select.relations when relation is not joined", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        relations: [{ name: "company", outputKey: "company", subPaths: [["id"], ["name"]] }],
      };
      const ctx = buildRelationContext(select, mockRelationsWithTarget, null, ["id"], "c");
      expect(ctx.relationFetches).toHaveLength(1);
      expect(ctx.relationFetches[0].relation.name).toBe("company");
      expect(ctx.columnPaths).not.toContainEqual(["company", "id"]);
    });

    it("deduplicates relations with same outputKey in select.relations", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        relations: [
          { name: "company", outputKey: "employer" },
          { name: "company", outputKey: "employer" }, // duplicate outputKey → skipped
        ],
      };
      const ctx = buildRelationContext(select, mockRelationsWithTarget, null, ["id"], "c");
      expect(ctx.relationFetches).toHaveLength(1);
    });

    it("excludes from fetches when target entity has no query method", () => {
      // mockRelations._target() returns {} (no query fn) → buildRelationFetchMeta returns null
      const select: IrSelect = {
        param: "c",
        paths: [["company"]],
        aliases: ["company"],
      };
      const ctx = buildRelationContext(select, mockRelations, null, ["id"], "c");
      expect(ctx.relationFetches).toHaveLength(0);
    });

    it("appends PK column for to-many relation when not already selected", () => {
      const select: IrSelect = {
        param: "u",
        paths: [["name"], ["posts"]],
        aliases: ["name", "posts"],
      };
      const ctx = buildRelationContext(select, mockRelationsToMany, null, ["id"], "u");
      expect(ctx.columnPaths!.some((p) => p[0] === "id")).toBe(true);
    });

    it("does not duplicate PK column for to-many when already selected", () => {
      const select: IrSelect = {
        param: "u",
        paths: [["id"], ["posts"]],
        aliases: ["id", "posts"],
      };
      const ctx = buildRelationContext(select, mockRelationsToMany, null, ["id"], "u");
      expect(ctx.columnPaths!.filter((p) => p[0] === "id")).toHaveLength(1);
    });

    it("adds default 'id' PK column when pkColumns is null (to-many)", () => {
      const select: IrSelect = {
        param: "u",
        paths: [["name"], ["posts"]],
        aliases: ["name", "posts"],
      };
      const ctx = buildRelationContext(select, mockRelationsToMany, null, null, "u");
      // pkColumns null → defaults to ["id"] so "id" is added to ensure to-many correlation works
      expect(ctx.columnPaths!.some((p) => p[0] === "id")).toBe(true);
    });
  });

  describe("buildRelationContext", () => {
    it("returns null columnPaths when no select", () => {
      const ctx = buildRelationContext(null, undefined, null, ["id"], "c");
      expect(ctx.columnPaths).toBeNull();
      expect(ctx.relationFetches).toHaveLength(0);
    });

    it("returns null columnPaths when select has no relation paths", () => {
      const select: IrSelect = { param: "c", paths: [["id"], ["name"]], aliases: ["id", "name"] };
      const ctx = buildRelationContext(select, mockRelations, null, ["id"], "c");
      expect(ctx.columnPaths).toBeNull();
    });

    it("populates skipLoadFor via paths when relation is reusable from join", () => {
      const whereIr = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company", "name"]],
        aliases: ["id", "company_name"],
      };
      const ctx = buildRelationContext(
        select,
        mockRelationsWithTarget,
        whereIr as any,
        ["id"],
        "c"
      );
      expect(ctx.reusableJoinKeys.has("company")).toBe(true);
      expect(ctx.skipLoadFor.has("company")).toBe(true);
    });

    it("handles relation in select.relations with no subPaths (subPaths?.length ?? 0 fallback)", () => {
      // Covers the `?? 0` branch when r.subPaths is undefined
      const whereIr = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        relations: [{ name: "company", outputKey: "company" }], // no subPaths → subPaths?.length = undefined → ?? 0
      };
      const ctx = buildRelationContext(select, mockRelationsWithTarget, whereIr as any, ["id"], "c");
      // subPaths undefined → (r.subPaths?.length ?? 0) = 0 → not > 0 → hasReusableRelationInSelect = false
      expect(ctx.hasReusableRelationInSelect).toBe(false);
    });

    it("evaluates select.relations ?? [] branch when select.relations is undefined", () => {
      // Relation is in paths as whole-segment ["company"] → length=1, not >1
      // So paths.some() returns false → || evaluates right side → relations ?? [] fires (line 63)
      const whereIr = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const select: IrSelect = {
        param: "c",
        paths: [["company"]], // single segment → length=1, not >1
        aliases: ["company"],
        // no relations property → selectIr.relations is undefined
      };
      const ctx = buildRelationContext(
        select,
        mockRelationsWithTarget,
        whereIr as any,
        ["id"],
        "c"
      );
      // reusableJoinKeys has "company" but hasReusableRelationInSelect = false (no matching path/relation)
      expect(ctx.reusableJoinKeys.has("company")).toBe(true);
      expect(ctx.hasReusableRelationInSelect).toBe(false);
    });

    it("populates skipLoadFor via select.relations when relation is reusable from join", () => {
      const whereIr = {
        kind: "binary",
        op: "===",
        left: { kind: "member", param: "c", path: ["company", "name"] },
        right: { kind: "const", value: "Acme" },
      };
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        relations: [{ name: "company", outputKey: "company", subPaths: [["id"], ["name"]] }],
      };
      const ctx = buildRelationContext(
        select,
        mockRelationsWithTarget,
        whereIr as any,
        ["id"],
        "c"
      );
      expect(ctx.skipLoadFor.has("company")).toBe(true);
    });
  });

  describe("alias fallback behavior (via buildRelationContext)", () => {
    it("falls back to last path segment when aliases array is shorter than paths", () => {
      // Include a relation path to make hasRelations = true so buildRelationContext
      // calls resolveSelectColumnsAndRelations and populates ctx.columnPaths/columnAliases.
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["name"], ["company", "name"]],
        aliases: [], // shorter → aliases[i] is undefined → fallback
      };
      const ctx = buildRelationContext(select, mockRelations, companyJoinWhereIr as any, ["id"], "c");
      expect(ctx.columnPaths).toContainEqual(["id"]);
      expect(ctx.columnAliases).toContain("id");
      expect(ctx.columnAliases).toContain("name");
    });

    it("uses relKey_field fallback alias for joined path when no explicit alias given", () => {
      // aliases is empty → joinedRelationColumnAlias receives undefined → ?? fallback
      const select: IrSelect = {
        param: "c",
        paths: [["id"], ["company", "name"]],
        aliases: [], // empty → aliases[1] for ["company","name"] is undefined
      };
      const ctx = buildRelationContext(select, mockRelations, companyJoinWhereIr as any, ["id"], "c");
      expect(ctx.columnAliases).toContain("company_name");
    });
  });

  describe("expandJoinedRelationToColumns — empty subPath", () => {
    it("skips empty sub-array entries inside subPaths", () => {
      const select: IrSelect = {
        param: "c",
        paths: [["id"]],
        aliases: ["id"],
        relations: [{ name: "company", outputKey: "company", subPaths: [[]] }], // empty subPath
      };
      const ctx = buildRelationContext(select, mockRelations, companyJoinWhereIr as any, ["id"], "c");
      // empty sub produces no column path
      expect(ctx.columnPaths).not.toContainEqual(["company"]);
      expect(ctx.columnPaths!.filter((p) => p[0] === "company")).toHaveLength(0);
    });
  });
});
