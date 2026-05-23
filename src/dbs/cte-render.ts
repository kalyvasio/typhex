/**
 * Compile registered CTE bodies in declaration order.
 */

import type { CompileQueryOpts, QueryCompiler, RenderedWithClause, WithClause } from "./types.js";
import { QueryPlanBuilder } from "../orm/helpers/query-plan/query-plan.js";
import type { FromSource, QueryState } from "../orm/query-state.js";

export function assertFromSourceAllowed(
  fromSource: FromSource | undefined,
  allowedCteNames: string[],
): void {
  if (fromSource?.kind !== "cte") return;
  if (!allowedCteNames.includes(fromSource.name)) {
    throw new Error(
      `from: unknown CTE ${JSON.stringify(fromSource.name)} — register it with withCte first`,
    );
  }
}

export function renderCtes(
  compiler: QueryCompiler,
  ctes: WithClause[] | undefined,
  allowedCteNames: string[] = [],
): RenderedWithClause[] {
  if (!ctes?.length) return [];

  const rendered: RenderedWithClause[] = [];
  let paramStartIndex = 1;

  for (const clause of ctes) {
    const innerState = clause.inner as QueryState<unknown>;
    const innerPlan = QueryPlanBuilder.build(innerState, { kind: "select" });
    const priorNames = [...allowedCteNames, ...rendered.map((c) => c.name)];
    assertFromSourceAllowed(innerPlan.fromSource, priorNames);
    const body = compiler.compilePlan(innerPlan, {
      paramStartIndex,
      allowedCteNames: priorNames,
    } satisfies CompileQueryOpts);
    rendered.push({
      name: clause.name,
      bodySql: body.sql,
      bodyParams: body.params,
    });
    paramStartIndex += body.params.length;
  }

  return rendered;
}

export function resolveFromClause(
  compiler: QueryCompiler,
  plan: {
    tableName: string;
    tableAlias: string;
    fromSource?: FromSource;
  },
  allowedCteNames: string[],
  paramStartIndex: number,
  compileOptions: CompileQueryOpts = {},
  escapeIdentifier: (name: string) => string,
): { fromClause: string; fromParams: unknown[] } {
  const source = plan.fromSource ?? { kind: "table" as const };
  const alias = escapeIdentifier(plan.tableAlias);

  switch (source.kind) {
    case "table":
      return {
        fromClause: `${escapeIdentifier(plan.tableName)} AS ${alias}`,
        fromParams: [],
      };
    case "cte":
      assertFromSourceAllowed(source, allowedCteNames);
      return {
        fromClause: `${escapeIdentifier(source.name)} AS ${alias}`,
        fromParams: [],
      };
    case "subquery": {
      const innerPlan = QueryPlanBuilder.build(source.state, { kind: "select" });
      const compiled = compiler.compilePlan(innerPlan, {
        wrap: true,
        paramStartIndex,
        allowedCteNames: compileOptions.allowedCteNames,
      });
      return {
        fromClause: `${compiled.sql} AS ${alias}`,
        fromParams: compiled.params,
      };
    }
  }
}
