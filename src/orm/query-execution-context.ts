import type { QueryOperation } from "../dbs/types.js";
import { QueryPlanBuilder } from "./helpers/query-plan/query-plan.js";
import type { QueryState } from "./query-state.js";

const isDebugSqlEnabled = ((): boolean => {
  const debugFlag = process?.env?.TYPHEX_DEBUG;
  return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes";
})();

export function buildQueryPlan<T>(state: QueryState<T>, operation: QueryOperation) {
  return QueryPlanBuilder.build(state, operation);
}

export function logSql(sql: string, params: unknown[]): void {
  if (!isDebugSqlEnabled) return;
  console.log("[typhex]", sql);
  if (params.length > 0) console.log("[typhex] params:", params);
}
