/**
 * Shared query-builder state and cloning helpers.
 */

import type { WithClause } from "../dbs/types.js";
import type {
  IrHaving,
  IrNode,
  IrOrderBy,
  IrSelect,
  IrWhere,
  EntityJoinHint,
  JoinHint,
} from "../ir/types.js";
import type { AnyEntityClass } from "../entity/entity.js";
import type { RelationsMap, RelationDef } from "../entity/relations.js";
import type { QueryExecutor } from "./db.js";

/** @internal — captured inline subquery state */
export interface CapturedSubquery {
  state: QueryState<unknown>;
}

export type FromSource =
  | { kind: "table" }
  | { kind: "cte"; name: string }
  | { kind: "subquery"; state: QueryState<unknown> };

/** Fields required to construct a {@link QueryState}. */
export interface QueryStateInit<T = unknown> {
  tableName: string;
  columnNames: string[];
  qe: QueryExecutor;
  pkColumns: string[];
  whereIr: IrWhere | null;
  whereParams: Record<string, unknown>;
  subqueryParams: Record<string, CapturedSubquery>;
  orderBy: IrOrderBy[];
  limitNum: number | null;
  offsetNum: number | null;
  selectIr: IrSelect | null;
  selectParams?: Record<string, unknown>;
  relations?: RelationsMap;
  hydrate?: (row: Record<string, unknown>) => T | Promise<T>;
  resolveRelationTarget?: (
    rel: RelationDef,
  ) => { table: string; pk: string[]; schema: Record<string, string> } | null;
  joinHints?: JoinHint[];
  /** JOIN to entity tables with custom ON (e.g. recursive CTE self-join). */
  entityJoinHints?: EntityJoinHint[];
  havingIr: IrHaving | null;
  havingParams: Record<string, unknown>;
  entity?: AnyEntityClass;
  /** UNION ALL branch appended to this SELECT (anchor.unionAll(recursive)). */
  unionAll?: QueryState<unknown>;
  ctes?: WithClause[];
  /** Registered sibling CTE names in scope (bodies built via `withCte` callback). */
  inScopeRegisteredCteNames?: string[];
  fromSource?: FromSource | null;
  /** Parsed SET column IR for UPDATE (set before plan; not cloned by default). */
  updateSetIr?: Record<string, IrNode>;
  /** Parsed VALUES column IR for INSERT / upsert (reserved; set before plan when supported). */
  insertIr?: Record<string, IrNode>;
}

/** @internal — internal builder state */
export class QueryState<T = unknown> implements QueryStateInit<T> {
  tableName: string;
  columnNames: string[];
  qe: QueryExecutor;
  pkColumns: string[];
  whereIr: IrWhere | null;
  whereParams: Record<string, unknown>;
  subqueryParams: Record<string, CapturedSubquery>;
  orderBy: IrOrderBy[];
  limitNum: number | null;
  offsetNum: number | null;
  selectIr: IrSelect | null;
  selectParams?: Record<string, unknown>;
  relations?: RelationsMap;
  hydrate?: (row: Record<string, unknown>) => T | Promise<T>;
  resolveRelationTarget?: (
    rel: RelationDef,
  ) => { table: string; pk: string[]; schema: Record<string, string> } | null;
  joinHints?: JoinHint[];
  entityJoinHints?: EntityJoinHint[];
  havingIr: IrHaving | null;
  havingParams: Record<string, unknown>;
  entity?: AnyEntityClass;
  unionAll?: QueryState<unknown>;
  ctes?: WithClause[];
  inScopeRegisteredCteNames?: string[];
  fromSource?: FromSource | null;
  updateSetIr?: Record<string, IrNode>;
  insertIr?: Record<string, IrNode>;

  constructor(init: QueryStateInit<T>) {
    this.tableName = init.tableName;
    this.columnNames = init.columnNames;
    this.qe = init.qe;
    this.pkColumns = init.pkColumns;
    this.whereIr = init.whereIr;
    this.whereParams = init.whereParams;
    this.subqueryParams = init.subqueryParams;
    this.orderBy = init.orderBy;
    this.limitNum = init.limitNum;
    this.offsetNum = init.offsetNum;
    this.selectIr = init.selectIr;
    this.selectParams = init.selectParams;
    this.relations = init.relations;
    this.hydrate = init.hydrate;
    this.resolveRelationTarget = init.resolveRelationTarget;
    this.joinHints = init.joinHints;
    this.entityJoinHints = init.entityJoinHints;
    this.havingIr = init.havingIr;
    this.havingParams = init.havingParams;
    this.entity = init.entity;
    this.unionAll = init.unionAll;
    this.ctes = init.ctes;
    this.inScopeRegisteredCteNames = init.inScopeRegisteredCteNames;
    this.fromSource = init.fromSource;
    this.updateSetIr = init.updateSetIr;
    this.insertIr = init.insertIr;
  }

  /** Deep-clone mutable query state bags and nested CTE / subquery bodies. */
  clone(): QueryState<T> {
    const subqueryParams: Record<string, CapturedSubquery> = {};
    for (const [key, captured] of Object.entries(this.subqueryParams)) {
      subqueryParams[key] = { state: captured.state.clone() };
    }

    return new QueryState({
      tableName: this.tableName,
      columnNames: [...this.columnNames],
      qe: this.qe,
      pkColumns: [...this.pkColumns],
      whereIr: this.whereIr,
      whereParams: { ...this.whereParams },
      subqueryParams,
      orderBy: [...this.orderBy],
      limitNum: this.limitNum,
      offsetNum: this.offsetNum,
      selectIr: this.selectIr,
      selectParams: this.selectParams ? { ...this.selectParams } : undefined,
      relations: this.relations,
      hydrate: this.hydrate,
      resolveRelationTarget: this.resolveRelationTarget,
      joinHints: this.joinHints ? [...this.joinHints] : undefined,
      entityJoinHints: this.entityJoinHints?.map((h) => ({
        joinType: h.joinType,
        entity: h.entity,
        onIr: h.onIr,
      })),
      havingIr: this.havingIr,
      havingParams: { ...this.havingParams },
      entity: this.entity,
      unionAll: this.unionAll?.clone(),
      ctes: this.ctes?.map((c) => ({
        name: c.name,
        kind: c.kind,
        inner: (c.inner as QueryState<unknown>).clone(),
      })),
      inScopeRegisteredCteNames: this.inScopeRegisteredCteNames
        ? [...this.inScopeRegisteredCteNames]
        : undefined,
      fromSource: QueryState.cloneFromSource(this.fromSource),
    });
  }

  private static cloneFromSource(source: FromSource | null | undefined): FromSource | undefined {
    if (!source) return undefined;
    if (source.kind === "subquery") {
      return { kind: "subquery", state: source.state.clone() };
    }
    return source;
  }
}
