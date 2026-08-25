import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QueryPlanBuilder } from "../../src/orm/helpers/query-plan/query-plan.js";
import { QueryState, type QueryStateInit } from "../../src/orm/query-state.js";
import { createMockDb } from "../helpers.js";

function queryState(overrides: Partial<QueryStateInit> = {}): QueryState {
  return new QueryState({
    tableName: "users",
    columnNames: ["id", "age"],
    qe: createMockDb(),
    pkColumns: ["id"],
    whereIr: null,
    whereParams: {},
    subqueryParams: {},
    orderBy: [],
    limitNum: null,
    offsetNum: null,
    selectIr: null,
    havingIr: null,
    havingParams: {},
    ...overrides,
  });
}

describe("QueryPlanBuilder nested plans", () => {
  it("plans CTE bodies, UNION branches, and inline FROM subqueries recursively", () => {
    const recursiveBranch = queryState({ fromSource: { kind: "cte", name: "tree" } });
    const cteBody = queryState({ unionAll: recursiveBranch });
    const fromBody = queryState({ limitNum: 3 });
    const state = queryState({
      ctes: [{ name: "tree", kind: "recursive", inner: cteBody }],
      fromSource: { kind: "subquery", state: fromBody },
    });

    const plan = QueryPlanBuilder.build(state, { kind: "select" });
    const cte = plan.ctes?.[0];
    const fromSource = plan.fromSource;

    expect(cte?.plan.unionAll?.fromSource).toEqual({ kind: "cte", name: "tree" });
    expect(cte).not.toHaveProperty("inner");
    expect(fromSource?.kind).toBe("subquery");
    if (fromSource?.kind !== "subquery") throw new Error("expected a subquery plan");
    expect(fromSource.plan.limitNum).toBe(3);
    expect(fromSource).not.toHaveProperty("state");
  });

  it("keeps the dialect compiler independent from query state and planning", () => {
    const source = readFileSync(
      new URL("../../src/dbs/query-compiler.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("QueryPlanBuilder");
    expect(source).not.toContain('from "../orm/query-state.js"');
  });
});
