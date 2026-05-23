/**
 * Shared query-builder state shapes and cloning helpers.
 */

import type { WithClause } from "../dbs/types.js";
import type { IrHaving, IrOrderBy, IrSelect, IrWhere, JoinHint } from "../ir/types.js";
import type { AnyEntityClass } from "../entity/entity.js";
import type { RelationsMap, RelationDef } from "../entity/relations.js";
import type { QueryExecutor } from "./db.js";

/** @internal — captured inline subquery state */
export interface CapturedSubquery {
  state: QueryState<unknown>;
}

/** @internal — internal builder state */
export interface QueryState<T = unknown> {
  tableName: string;
  columnNames: string[];
  qe: QueryExecutor;
  /** Primary key column names (single, composite, or empty for keyless tables). */
  pkColumns: string[];
  whereIr: IrWhere | null;
  whereParams: Record<string, unknown>;
  subqueryParams: Record<string, CapturedSubquery>;
  orderBy: IrOrderBy[];
  limitNum: number | null;
  offsetNum: number | null;
  selectIr: IrSelect | null;
  relations?: RelationsMap;
  hydrate?: (row: Record<string, unknown>) => T | Promise<T>;
  resolveRelationTarget?: (
    rel: RelationDef,
  ) => { table: string; pk: string[]; schema: Record<string, string> } | null;
  joinHints?: JoinHint[];
  havingIr: IrHaving | null;
  havingParams: Record<string, unknown>;
  entity?: AnyEntityClass;
  /** WITH clauses (uncompiled inner states); rendered during outer-query compilation. */
  ctes?: WithClause[];
  /** When set, the outer FROM reads from this source instead of the entity table. */
  fromSource?: FromSource | null;
}

export type FromSource =
  | { kind: "table" }
  | { kind: "cte"; name: string }
  | { kind: "subquery"; state: QueryState<unknown> };

export const CTE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertValidCteName(name: string): void {
  if (!CTE_NAME_RE.test(name)) {
    throw new Error(
      `withCte: invalid CTE name ${JSON.stringify(name)} — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
}

export function assertUniqueCteName(ctes: WithClause[] | undefined, name: string): void {
  if (ctes?.some((c) => c.name === name)) {
    throw new Error(`withCte: duplicate CTE name ${JSON.stringify(name)}`);
  }
}

function cloneFromSource(source: FromSource | null | undefined): FromSource | undefined {
  if (!source) return undefined;
  if (source.kind === "subquery") {
    return { kind: "subquery", state: cloneQueryState(source.state) };
  }
  return source;
}

/** Deep-clone mutable query state bags and nested CTE / subquery bodies. */
export function cloneQueryState<T>(state: QueryState<T>): QueryState<T> {
  const subqueryParams: Record<string, CapturedSubquery> = {};
  for (const [key, captured] of Object.entries(state.subqueryParams)) {
    subqueryParams[key] = { state: cloneQueryState(captured.state) };
  }

  return {
    tableName: state.tableName,
    columnNames: [...state.columnNames],
    qe: state.qe,
    pkColumns: [...state.pkColumns],
    whereIr: state.whereIr,
    whereParams: { ...state.whereParams },
    subqueryParams,
    orderBy: [...state.orderBy],
    limitNum: state.limitNum,
    offsetNum: state.offsetNum,
    selectIr: state.selectIr,
    relations: state.relations,
    hydrate: state.hydrate,
    resolveRelationTarget: state.resolveRelationTarget,
    joinHints: state.joinHints ? [...state.joinHints] : undefined,
    havingIr: state.havingIr,
    havingParams: { ...state.havingParams },
    entity: state.entity,
    ctes: state.ctes?.map((c) => ({
      name: c.name,
      kind: "simple" as const,
      inner: cloneQueryState(c.inner as QueryState<unknown>),
    })),
    fromSource: cloneFromSource(state.fromSource),
  };
}
