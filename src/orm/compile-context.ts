/**
 * Compile-context helpers: derive JOIN descriptors, table-alias mappings, and
 * compile options from a QueryState so dialect compilers have everything they need.
 */

import type { IrOrderBy, IrSelect } from "../ir/types.js";
import { collectParamNamesFromWhere } from "../ir/types.js";
import { getDialect } from "../dbs/index.js";
import type { DialectImpl } from "../dbs/types.js";
import {
  buildRelationJoins,
  buildRelationPathToAlias,
  buildOneToManyExists,
  type RelationJoinInfo,
} from "./relation-joins.js";
import type { QueryState } from "./query-builder.js";

export const DEFAULT_ROW_PARAM = "u";
export const TABLE_ALIAS = "t0";

/** Resolve the dialect implementation for the current driver, defaulting to SQLite. */
export function getDialectOrThrow(state: QueryState<unknown>) {
  return getDialect(state.qe.dialect ?? "sqlite");
}

/** Derive the row parameter name used in IR expressions (e.g. "u", "c")
 *  from whichever of selectIr, whereIr, or orderBy is available. */
export function getRootParam(state: QueryState<unknown>): string {
  if (state.selectIr?.param) return state.selectIr.param;
  if (state.whereIr) {
    const names = new Set<string>();
    collectParamNamesFromWhere(state.whereIr, names);
    const first = names.values().next().value;
    if (first) return first;
  }
  return state.orderBy[0]?.param ?? DEFAULT_ROW_PARAM;
}

/** Map every row-parameter name in the query to the main table alias (t0),
 *  so the dialect compiler can qualify column references correctly. */
export function buildParamToAlias(state: QueryState<unknown>): Record<string, string> {
  const names = new Set<string>();
  names.add(DEFAULT_ROW_PARAM);
  if (state.whereIr) collectParamNamesFromWhere(state.whereIr, names);
  for (const o of state.orderBy) names.add(o.param);
  if (state.selectIr) names.add(state.selectIr.param);
  const paramToAlias: Record<string, string> = {};
  for (const p of names) paramToAlias[p] = TABLE_ALIAS;
  return paramToAlias;
}

/** Return JOIN descriptors for any relations referenced in the WHERE/SELECT/ORDER BY,
 *  or an empty array when there are no relations. */
export function getRelationJoins(state: QueryState<unknown>): RelationJoinInfo[] {
  const { relations, resolveRelationTarget } = state;
  if (!relations || Object.keys(relations).length === 0 || !resolveRelationTarget) {
    return [];
  }
  const rootParam = getRootParam(state);
  return buildRelationJoins(
    {
      relations,
      tableName: state.tableName,
      columnNames: state.columnNames,
      pkColumn: state.pkColumn ?? "id",
      resolveTarget: resolveRelationTarget,
    },
    state.whereIr,
    state.selectIr,
    rootParam,
    state.orderBy,
    state.joinHints
  );
}

/** Compile all relation joins to a SQL JOIN fragment. */
export function buildJoinsSql(state: QueryState<unknown>, dialect: DialectImpl): string {
  return getRelationJoins(state).map((j) => dialect.buildJoinClause(j)).join("");
}

/** Assemble the compile options passed to every dialect compiler call:
 *  table alias mapping, JOIN alias lookup, and EXISTS subquery info. */
export function getCompileOpts(state: QueryState<unknown>) {
  const paramToAlias = buildParamToAlias(state);
  const joins = getRelationJoins(state);
  const rootParam = getRootParam(state);
  const relationPathToAlias = buildRelationPathToAlias(joins, Object.keys(paramToAlias));
  const mainPk = state.pkColumn ?? "id";
  const oneToManyExists =
    state.relations && state.resolveRelationTarget
      ? buildOneToManyExists(
          state.whereIr,
          state.relations,
          rootParam,
          mainPk,
          state.resolveRelationTarget
        )
      : undefined;
  return {
    tableAlias: TABLE_ALIAS,
    paramToAlias,
    relationPathToAlias: Object.keys(relationPathToAlias).length > 0 ? relationPathToAlias : undefined,
    oneToManyExists: oneToManyExists && Object.keys(oneToManyExists).length > 0 ? oneToManyExists : undefined,
  };
}
