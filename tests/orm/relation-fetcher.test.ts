import { describe, it, expect, vi } from "vitest";
import { fetchRelations } from "../../src/orm/relation-fetcher.js";
import type { RelationFetchMetadata } from "../../src/orm/relation-context-builder.js";

/** Builds a spy-able query builder chain whose toArray returns `rows`. */
function makeChain(rows: Record<string, unknown>[]) {
  const chain: Record<string, any> = {};
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.offset = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.toArray = vi.fn().mockResolvedValue(rows);
  return chain;
}

function makeMeta(
  rows: Record<string, unknown>[],
  overrides: Partial<RelationFetchMetadata & { relation: any }> = {}
): { meta: RelationFetchMetadata; chain: ReturnType<typeof makeChain> } {
  const chain = makeChain(rows);
  const meta: RelationFetchMetadata = {
    relationType: "many-to-one",
    relation: { name: "company", outputKey: "company" },
    fkColumns: ["companyId"],
    targetPkColumns: ["id"],
    targetEntity: { query: () => chain } as any,
    ...overrides,
  };
  return { meta, chain };
}

describe("fetchRelations", () => {
  it("skips a relation that is in the skip set", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta } = makeMeta([{ id: 10 }]);
    const result = await fetchRelations(null as any, rows, [meta], new Set(["company"]));
    expect(result.has("company")).toBe(false);
  });

  it("returns empty map for to-many when no rows have an id", async () => {
    const rows = [{ noId: true }];
    const { meta } = makeMeta([]);
    (meta as any).relationType = "one-to-many";
    (meta.relation as any).name = "posts";
    const result = await fetchRelations(null as any, rows, [meta], new Set());
    const postsMap = result.get("posts");
    expect(postsMap).toBeDefined();
    expect(postsMap!.size).toBe(0);
  });

  it("returns empty map for to-one when no rows have the fk column", async () => {
    const rows = [{ id: 1 }]; // no "companyId" → buildFetchByIdIr returns null
    const { meta } = makeMeta([]);
    const result = await fetchRelations(null as any, rows, [meta], new Set());
    const companyMap = result.get("company");
    expect(companyMap).toBeDefined();
    expect(companyMap!.size).toBe(0);
  });

  it("fetches to-one relations and indexes by targetPk", async () => {
    const rows = [{ id: 1, companyId: 10 }, { id: 2, companyId: 20 }];
    const relatedRows = [{ id: 10, name: "Acme" }, { id: 20, name: "Globex" }];
    const { meta } = makeMeta(relatedRows);

    const result = await fetchRelations(null as any, rows, [meta], new Set());
    const map = result.get("company") as Map<string, unknown>;
    expect(map.get("10")).toEqual({ id: 10, name: "Acme" });
    expect(map.get("20")).toEqual({ id: 20, name: "Globex" });
  });

  it("fetches to-many relations and groups by fkColumn", async () => {
    const rows = [{ id: 5 }, { id: 6 }];
    const relatedRows = [{ id: 1, userId: 5 }, { id: 2, userId: 5 }, { id: 3, userId: 6 }];
    const { meta } = makeMeta(relatedRows, {
      relationType: "one-to-many",
      relation: { name: "posts", outputKey: "posts" },
      fkColumns: ["userId"],
    } as any);

    const result = await fetchRelations(null as any, rows, [meta], new Set());
    const map = result.get("posts") as Map<string, unknown[]>;
    expect(map.get("5")).toHaveLength(2);
    expect(map.get("6")).toHaveLength(1);
  });

  it("applies orderBy to the query chain", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta, chain } = makeMeta([{ id: 10 }]);
    (meta.relation as any).orderBy = [{ path: ["name"], direction: "asc" }];

    await fetchRelations(null as any, rows, [meta], new Set());

    expect(chain.orderBy).toHaveBeenCalledWith("name", "asc");
  });

  it("applies limitNum to the query chain", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta, chain } = makeMeta([{ id: 10 }]);
    (meta.relation as any).limitNum = 5;

    await fetchRelations(null as any, rows, [meta], new Set());

    expect(chain.limit).toHaveBeenCalledWith(5);
  });

  it("applies offsetNum to the query chain", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta, chain } = makeMeta([{ id: 10 }]);
    (meta.relation as any).offsetNum = 10;

    await fetchRelations(null as any, rows, [meta], new Set());

    expect(chain.offset).toHaveBeenCalledWith(10);
  });

  it("projects subPaths and appends anchorColumn when missing", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta, chain } = makeMeta([{ id: 10, name: "Acme" }]);
    (meta.relation as any).subPaths = [["name"]];

    await fetchRelations(null as any, rows, [meta], new Set());

    // anchorColumn for to-one is targetPk ("id"), not in subPaths → must be appended
    expect(chain.select).toHaveBeenCalledWith(expect.arrayContaining(["name", "id"]));
  });

  it("does not duplicate anchorColumn in select when it is already in subPaths", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta, chain } = makeMeta([{ id: 10, name: "Acme" }]);
    (meta.relation as any).subPaths = [["id"], ["name"]]; // "id" is the anchorColumn

    await fetchRelations(null as any, rows, [meta], new Set());

    const selectedCols: string[] = chain.select.mock.calls[0][0];
    expect(selectedCols.filter((c) => c === "id")).toHaveLength(1);
  });

  it("handles empty path array in orderBy (uses empty string as column name)", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta, chain } = makeMeta([{ id: 10 }]);
    (meta.relation as any).orderBy = [{ path: [], direction: "desc" }]; // path[0] is undefined → ?? ""

    await fetchRelations(null as any, rows, [meta], new Set());

    expect(chain.orderBy).toHaveBeenCalledWith("", "desc");
  });

  it("handles empty sub-array in subPaths (uses fallback via ??)", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta, chain } = makeMeta([{ id: 10, name: "Acme" }]);
    (meta.relation as any).subPaths = [[], ["name"]]; // [] entry → flatMap collapses it

    await fetchRelations(null as any, rows, [meta], new Set());

    const selectedCols: string[] = chain.select.mock.calls[0][0];
    expect(selectedCols).toContain("name");
  });

  it("applies whereIr when relation has a where clause", async () => {
    const rows = [{ id: 1, companyId: 10 }];
    const { meta, chain } = makeMeta([{ id: 10 }]);
    (meta.relation as any).whereIr = { kind: "const", value: true };
    (meta.relation as any).whereParams = { active: true };

    await fetchRelations(null as any, rows, [meta], new Set());

    // where should have been called with a combined (AND) whereIr
    expect(chain.where).toHaveBeenCalled();
  });

  it("many-to-many: queries junction then groups targets by parent PK", async () => {
    const parentRows = [{ id: 1 }, { id: 2 }];
    const junctionRows = [
      { userId: 1, tagId: 10 },
      { userId: 1, tagId: 20 },
      { userId: 2, tagId: 20 },
    ];
    const tagRows = [{ id: 10, name: "ts" }, { id: 20, name: "js" }];
    const chain = makeChain(tagRows);
    const qe = {
      dialect: "sqlite" as const,
      query: vi.fn().mockResolvedValue(junctionRows),
      run: vi.fn(),
    };

    const meta: RelationFetchMetadata = {
      relationType: "many-to-many",
      relation: { name: "tags", outputKey: "tags" } as any,
      fkColumns: ["tagId"],
      targetPkColumns: ["id"],
      targetEntity: { query: () => chain } as any,
      parentPkColumns: ["id"],
      junction: { table: "user_tags", foreignKey: ["userId"], referenceKey: ["tagId"] },
    };

    const result = await fetchRelations(qe as any, parentRows, [meta], new Set());
    const map = result.get("tags") as Map<string, unknown[]>;

    // parent 1 → 2 tags; parent 2 → 1 tag
    expect(map.get(JSON.stringify(1))).toHaveLength(2);
    expect(map.get(JSON.stringify(2))).toHaveLength(1);
    // junction query used dialect escaping
    expect(qe.query).toHaveBeenCalledTimes(1);
  });
});
