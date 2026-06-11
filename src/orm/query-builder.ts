/**
 * Query builder: the single place where all SQL is built and executed.
 * Provides both query (select, count) and mutation (insert, update, delete)
 * methods. All methods that hit the database return Promises
 * (except insert, which is synchronous to support save()).
 */

import {
  type IrHaving,
  type IrOrderBy,
  type IrSelect,
  type IrWhere,
  type OrderDirection,
  type JoinHint,
  type JoinType,
  isIrOrderBy,
} from "../ir/types.js";
import type { AnyEntityClass, EntityInstance, SelectRow } from "../entity/entity.js";
import {
  resolveWhereIr,
  resolveHavingIr,
  resolveJoinOnIr,
  resolveOrderBy,
  resolveSelectIr,
  resolveGroupByPaths,
  resolveJoinKeys,
  resolveUpdateSet,
} from "../parser/resolve.js";
import { type OnConflictClause, type QueryOperation } from "../dbs/types.js";
import { RelationResolver } from "./helpers/relations/relation-resolver.js";
import { buildFindByIdIr, pkToRecord } from "./query-helpers.js";
import {
  DEFAULT_ROW_PARAM,
  QueryPlanBuilder,
  getQueryCompilerOrThrow,
} from "./helpers/query-plan/query-plan.js";
import { InsertGraphPlanner } from "./helpers/insert-graph/insert-graph-planner.js";
import { QueryState, type CapturedSubquery, type QueryStateInit } from "./query-state.js";

export { QueryState } from "./query-state.js";
export type { CapturedSubquery, FromSource, QueryStateInit } from "./query-state.js";

/** Whether the builder reads from the base table or a registered CTE. */
export type QueryFromKind = "table" | "cte";

/** Default `Ctes` map: no registered names (`keyof` is `never`, not `string`). */
export type NoCtes = Record<never, never>;

/** Registered CTE names → row types (second arg to `where` / `withCte` callback). */
export type RegisteredCtes<Ctes extends Record<string, unknown>> = Ctes;

/** Base table row for `where` / `update` (not merged with CTE namespaces). */
export type TableRow<
  C extends AnyEntityClass,
  T,
  FromKind extends QueryFromKind,
> = FromKind extends "cte" ? T : T extends EntityInstance<C> ? T : EntityInstance<C>;

type HasRegisteredCtes<Ctes extends Record<string, unknown>> = keyof Ctes extends never
  ? false
  : true;

/** C = entity; T = row shape; Ctes = registered CTE names → row types; FromKind = table vs CTE read. */
export class QueryBuilder<
  C extends AnyEntityClass = AnyEntityClass,
  T = EntityInstance<C>,
  Ctes extends Record<string, unknown> = NoCtes,
  FromKind extends QueryFromKind = "table",
> {
  /** @internal */
  protected static readonly isDebugSqlEnabled = ((): boolean => {
    const debugFlag = process?.env?.TYPHEX_DEBUG;
    return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes";
  })();

  /** @internal */
  protected state: QueryState<T>;
  /** @internal */
  constructor(state: QueryState<T> | QueryStateInit<T>) {
    this.state = state instanceof QueryState ? state : new QueryState(state);
  }

  /** Return a shallow copy of this builder with mutable state (params, orderBy) deep-copied,
   *  so chained calls do not mutate the original. */
  clone(): QueryBuilder<C, T, Ctes, FromKind> {
    return new QueryBuilder(this.state.clone());
  }

  /** @internal — Print the SQL and parameters to stdout when TYPHEX_DEBUG is enabled. */
  protected logSql(sql: string, params: unknown[]): void {
    console.log("[typhex]", sql);
    if (params.length > 0) console.log("[typhex] params:", params);
  }

  protected buildPlan(operation: QueryOperation) {
    return QueryPlanBuilder.build(this.state, operation);
  }

  protected requirePkColumns(context: string): string[] {
    if (this.state.pkColumns.length === 0) {
      throw new Error(`[typhex] ${context}: entity "${this.state.tableName}" has no primary key`);
    }
    return this.state.pkColumns;
  }

  private static splitParams(params?: Record<string, unknown>) {
    const sqlParams: Record<string, unknown> = {};
    const subqueryParams: Record<string, CapturedSubquery> = {};

    for (const [key, value] of Object.entries(params ?? {})) {
      if (value instanceof QueryBuilder) {
        subqueryParams[key] = { state: value.state };
      } else {
        sqlParams[key] = value;
      }
    }

    return { sqlParams, subqueryParams };
  }

  /** @internal — used by the TypeScript transformer */
  where(predicate: IrWhere, params?: Record<string, unknown>): this;
  /** Set or replace the WHERE predicate (requires Typhex transformer when using arrows). */
  where(
    predicate: FromKind extends "cte"
      ? (row: T) => boolean
      : HasRegisteredCtes<Ctes> extends true
        ? (row: TableRow<C, T, FromKind>, ctes: RegisteredCtes<Ctes>) => boolean
        : (row: TableRow<C, T, FromKind>) => boolean,
    params?: Record<string, unknown>,
  ): this;
  where(
    predicate: IrWhere | ((row: any, ctes?: any) => boolean),
    params?: Record<string, unknown>,
  ): this {
    const { sqlParams, subqueryParams } = QueryBuilder.splitParams(params);
    Object.assign(this.state.whereParams, sqlParams);
    Object.assign(this.state.subqueryParams, subqueryParams);
    this.state.whereIr = resolveWhereIr(
      predicate as IrWhere | ((entity: unknown) => boolean),
      params ? Object.keys(params) : [],
      Object.keys(subqueryParams),
    );
    return this;
  }

  /** @internal — used by the TypeScript transformer */
  orderBy(
    ir: IrOrderBy,
    directionOrParams?: OrderDirection | Record<string, unknown>,
    subqueryParams?: Record<string, unknown>,
  ): this;
  /** Append an ORDER BY clause. Accepts a dot-separated column string or
   *  an arrow function parsed to a member path at runtime. */
  orderBy(col: string | ((row: T) => unknown), direction?: OrderDirection): this;
  orderBy(
    colOrIr: IrOrderBy | string | ((row: T) => unknown),
    directionOrParams: OrderDirection | Record<string, unknown> = "asc",
    subqueryParams?: Record<string, unknown>,
  ): this {
    let direction: OrderDirection = "asc";
    let paramsBag: Record<string, unknown> | undefined;

    if (isIrOrderBy(colOrIr)) {
      direction = colOrIr.direction;
      if (typeof directionOrParams === "string") {
        paramsBag = subqueryParams;
      } else if (directionOrParams !== undefined) {
        paramsBag = directionOrParams;
      }
    } else {
      direction = typeof directionOrParams === "string" ? directionOrParams : "asc";
      paramsBag = typeof directionOrParams === "object" ? directionOrParams : subqueryParams;
    }

    const { sqlParams, subqueryParams: captured } = QueryBuilder.splitParams(paramsBag);
    Object.assign(this.state.subqueryParams, captured);
    if (Object.keys(sqlParams).length > 0) {
      this.state.selectParams = { ...this.state.selectParams, ...sqlParams };
    }
    const paramKeys = Object.keys({ ...this.state.selectParams, ...sqlParams });
    this.state.orderBy.push(
      resolveOrderBy(
        colOrIr as IrOrderBy | string | ((row: unknown) => unknown),
        direction,
        paramKeys,
      ),
    );
    return this;
  }

  /** Adds an INNER JOIN for relation keys, or to an entity table with a custom ON. */
  innerJoin(keysOrFn: string[] | ((row: T) => unknown)): this;
  innerJoin<E extends AnyEntityClass>(
    entity: E,
    on: (joined: EntityInstance<E>, row: T) => boolean,
  ): this;
  innerJoin(
    keysOrFnOrEntity: string[] | ((row: T) => unknown) | AnyEntityClass,
    onFn?: (joined: EntityInstance<any>, row: T) => boolean,
  ): this {
    return this.addJoin(keysOrFnOrEntity, onFn, "inner");
  }

  /** Adds a LEFT JOIN for relation keys, or to an entity table with a custom ON. */
  leftJoin(keysOrFn: string[] | ((row: T) => unknown)): this;
  leftJoin<E extends AnyEntityClass>(
    entity: E,
    on: (joined: EntityInstance<E>, row: T) => boolean,
  ): this;
  leftJoin(
    keysOrFnOrEntity: string[] | ((row: T) => unknown) | AnyEntityClass,
    onFn?: (joined: EntityInstance<any>, row: T) => boolean,
  ): this {
    return this.addJoin(keysOrFnOrEntity, onFn, "left");
  }

  /** Adds a RIGHT JOIN for relation keys, or to an entity table with a custom ON. */
  rightJoin(keysOrFn: string[] | ((row: T) => unknown)): this;
  rightJoin<E extends AnyEntityClass>(
    entity: E,
    on: (joined: EntityInstance<E>, row: T) => boolean,
  ): this;
  rightJoin(
    keysOrFnOrEntity: string[] | ((row: T) => unknown) | AnyEntityClass,
    onFn?: (joined: EntityInstance<any>, row: T) => boolean,
  ): this {
    return this.addJoin(keysOrFnOrEntity, onFn, "right");
  }

  /** Adds a CROSS JOIN for the given relation keys or accessor function. */
  crossJoin(keysOrFn: string[] | ((row: T) => unknown)): this {
    return this.addJoinHints(keysOrFn, "cross");
  }

  /** Adds a FULL OUTER JOIN for relation keys, or to an entity table with a custom ON. */
  fullJoin(keysOrFn: string[] | ((row: T) => unknown)): this;
  fullJoin<E extends AnyEntityClass>(
    entity: E,
    on: (joined: EntityInstance<E>, row: T) => boolean,
  ): this;
  fullJoin(
    keysOrFnOrEntity: string[] | ((row: T) => unknown) | AnyEntityClass,
    onFn?: (joined: EntityInstance<any>, row: T) => boolean,
  ): this {
    return this.addJoin(keysOrFnOrEntity, onFn, "full");
  }

  private addJoin(
    keysOrFnOrEntity: string[] | ((row: T) => unknown) | AnyEntityClass,
    onFn: ((joined: EntityInstance<any>, row: T) => boolean) | undefined,
    joinType: JoinType,
  ): this {
    if (QueryBuilder.isEntityClass(keysOrFnOrEntity)) {
      if (!onFn) {
        throw new Error(`${joinType}Join(entity): ON callback is required`);
      }
      const onIr = resolveJoinOnIr(joinType, onFn as (joined: unknown, row: unknown) => boolean);
      this.state.entityJoinHints = [
        ...(this.state.entityJoinHints ?? []),
        { joinType, entity: keysOrFnOrEntity, onIr },
      ];
      return this;
    }
    return this.addJoinHints(keysOrFnOrEntity as string[] | ((row: T) => unknown), joinType);
  }

  private static isEntityClass(value: unknown): value is AnyEntityClass {
    if (typeof value !== "function" || value == null) return false;
    const cls = value as unknown as AnyEntityClass;
    return typeof cls.table?._table === "string";
  }

  private addJoinHints(keysOrFn: string[] | ((row: T) => unknown), joinType: JoinType): this {
    const relationKeys = resolveJoinKeys(keysOrFn as string[] | ((row: unknown) => unknown));
    const newHints: JoinHint[] = relationKeys.map((k) => ({ relationKey: k, joinType }));
    this.state.joinHints = [...(this.state.joinHints ?? []), ...newHints];
    return this;
  }

  /** Set the maximum number of rows to return. */
  limit(n: number): this {
    this.state.limitNum = n;
    return this;
  }

  /** Set the number of rows to skip before returning results. */
  offset(n: number): this {
    this.state.offsetNum = n;
    return this;
  }

  withCte<const N extends string, IC extends AnyEntityClass, IT>(
    name: N,
    subquery: QueryBuilder<IC, IT, any, any>,
  ): QueryBuilder<C, T, Ctes & Record<N, IT>, FromKind>;
  withCte<const N extends string, IC extends AnyEntityClass, IT>(
    name: N,
    build: (ctes: RegisteredCtes<Ctes>) => QueryBuilder<IC, IT, any, any>,
  ): QueryBuilder<C, T, Ctes & Record<N, IT>, FromKind>;
  withCte<const N extends string, IC extends AnyEntityClass, IT>(
    name: N,
    subqueryOrBuild:
      | QueryBuilder<IC, IT, any, any>
      | ((ctes: RegisteredCtes<Ctes>) => QueryBuilder<IC, IT, any, any>),
  ): QueryBuilder<C, T, Ctes & Record<N, IT>, FromKind> {
    const next = this.clone();
    const registeredCteNames = (next.state.ctes ?? []).map((c) => c.name);
    const inner =
      typeof subqueryOrBuild === "function"
        ? subqueryOrBuild({} as RegisteredCtes<Ctes>)
        : subqueryOrBuild;
    const innerState = inner.state.clone();
    if (typeof subqueryOrBuild === "function") {
      innerState.inScopeRegisteredCteNames = registeredCteNames;
    }
    next.state.ctes = [...(next.state.ctes ?? []), { name, kind: "simple", inner: innerState }];
    return next as QueryBuilder<C, T, Ctes & Record<N, IT>, FromKind>;
  }

  /**
   * Register a recursive CTE: `WITH RECURSIVE name AS (<anchor> UNION ALL <recursive>)`.
   * The body should use `.unionAll()` for the recursive step and may `.from(name)` for self-reference.
   */
  withRecursiveCte<const N extends string, IC extends AnyEntityClass, IT>(
    name: N,
    subquery: QueryBuilder<IC, IT, any, any>,
  ): QueryBuilder<C, T, Ctes & Record<N, IT>, FromKind> {
    const next = this.clone();
    next.state.ctes = [
      ...(next.state.ctes ?? []),
      { name, kind: "recursive", inner: subquery.state.clone() },
    ];
    return next as QueryBuilder<C, T, Ctes & Record<N, IT>, FromKind>;
  }

  /** Append a `UNION ALL` branch to this SELECT (used for recursive CTE bodies). */
  unionAll<OC extends AnyEntityClass, OT>(
    other: QueryBuilder<OC, OT, any, any>,
  ): QueryBuilder<C, T, Ctes, FromKind> {
    const next = this.clone();
    next.state.unionAll = other.state.clone();
    return next;
  }

  /**
   * Set the outer FROM source: registered CTE name, inline subquery, or base table.
   * Omit the argument to read from the entity's base table.
   */
  from<N extends keyof Ctes & string>(name: N): QueryBuilder<C, Ctes[N], Ctes, "cte">;
  from<Row = EntityInstance<C>>(name: string): QueryBuilder<C, Row, Ctes, "cte">;
  from<Row>(source: QueryBuilder<any, Row>): QueryBuilder<C, Row, Ctes, "table">;
  from(): QueryBuilder<C, EntityInstance<C>, Ctes, "table">;
  from<Row>(
    source?: string | QueryBuilder<any, Row>,
  ): QueryBuilder<C, unknown, Ctes, QueryFromKind> {
    const next = this.clone();
    if (source === undefined) {
      next.state.fromSource = { kind: "table" };
      return next as QueryBuilder<C, EntityInstance<C>, Ctes, "table">;
    }
    if (typeof source === "string") {
      next.state.fromSource = { kind: "cte", name: source };
      return next as unknown as QueryBuilder<C, Row, Ctes, "cte">;
    }
    next.state.fromSource = { kind: "subquery", state: source.state.clone() };
    return next as unknown as QueryBuilder<C, Row, Ctes, "table">;
  }

  /** Sets the SELECT projection using an arrow function parsed at runtime or by the TypeScript transformer. */
  select<U>(fn: (row: SelectRow<C>) => U): QueryBuilder<C, U, Ctes>;
  /** Sets the SELECT projection using an explicit list of column names. */
  select(columns: string[]): QueryBuilder<C, T, Ctes>;
  /** @internal — used by the TypeScript transformer */
  select(ir: IrSelect, params?: Record<string, unknown>): QueryBuilder<C, T, Ctes>;
  select(
    columnsOrIr: string[] | IrSelect | ((row: SelectRow<C>) => Record<string, unknown>),
    params?: Record<string, unknown>,
  ): QueryBuilder<C, unknown, Ctes> {
    const { sqlParams, subqueryParams: captured } = QueryBuilder.splitParams(params);
    Object.assign(this.state.subqueryParams, captured);
    if (params !== undefined) {
      this.state.selectParams = sqlParams;
    }
    this.state.selectIr = resolveSelectIr(
      columnsOrIr as string[] | IrSelect | ((row: unknown) => Record<string, unknown>),
      params !== undefined ? Object.keys(sqlParams) : [],
    );
    return this as QueryBuilder<C, unknown, Ctes>;
  }

  /** Adds a GROUP BY clause. Accepts column names, index numbers, or an arrow function selecting group-by fields. */
  groupBy(
    columnOrFn: string | string[] | number | number[] | ((row: EntityInstance<C>) => unknown),
    ...rest: (string | number)[]
  ): this {
    const entries = resolveGroupByPaths(
      columnOrFn as string | string[] | number | number[] | ((row: unknown) => unknown),
      ...rest,
    );
    const nextSelectIr = this.state.selectIr ?? { param: DEFAULT_ROW_PARAM, paths: [] };
    const memberPaths = entries.filter((e): e is string[] => Array.isArray(e));
    this.state.selectIr = {
      ...nextSelectIr,
      paths: nextSelectIr.paths.length > 0 ? nextSelectIr.paths : memberPaths,
      groupBy: entries,
    };
    return this;
  }

  /** @internal — used by the TypeScript transformer */
  having(predicate: IrHaving, params?: Record<string, unknown>): this;
  /** Adds a HAVING clause to filter aggregated groups (use together with `groupBy`). */
  having(
    predicate: HasRegisteredCtes<Ctes> extends true
      ? (row: EntityInstance<C>, ctes: RegisteredCtes<Ctes>) => boolean
      : (row: EntityInstance<C>) => boolean,
    params?: Record<string, unknown>,
  ): this;
  having(
    predicate: IrHaving | ((row: any, ctes?: any) => boolean),
    params?: Record<string, unknown>,
  ): this {
    const { sqlParams, subqueryParams } = QueryBuilder.splitParams(params);
    Object.assign(this.state.subqueryParams, subqueryParams);
    this.state.havingIr = resolveHavingIr(
      predicate as IrHaving | ((entity: unknown) => boolean),
      params ? Object.keys(params) : [],
      Object.keys(subqueryParams),
    );
    this.state.havingParams = sqlParams;
    return this;
  }

  /** Update matching rows with `set`, then re-fetch and return the updated row,
   *  or null if no matching row is found after the update. */
  async patch(set: Record<string, unknown>): Promise<EntityInstance<C> | null> {
    await this.update(set);
    const fresh = new QueryBuilder<C, T>({
      ...this.state,
      orderBy: [],
      limitNum: null,
      offsetNum: null,
      selectIr: null,
      ctes: undefined,
      fromSource: undefined,
    });
    return (await fresh.first()) ?? null;
  }

  /** Insert a single row. Awaitable directly, or chain `.onConflict(cols).doUpdate()` / `.doNothing()`. */
  insert(row: Record<string, unknown>): InsertBuilder<C, EntityInstance<C> | undefined> {
    return new InsertBuilder<C, EntityInstance<C> | undefined>(
      this.state as QueryState<EntityInstance<C>>,
      row,
    );
  }

  /** Insert multiple rows in one statement. Awaitable directly, or chain `.onConflict(cols).doUpdate()` / `.doNothing()`. */
  insertMany(rows: Record<string, unknown>[]): InsertBuilder<C, EntityInstance<C>[]> {
    return new InsertBuilder<C, EntityInstance<C>[]>(
      this.state as QueryState<EntityInstance<C>>,
      rows,
    );
  }

  /** Inserts an entity and its nested related entities in a single transactional operation. */
  async insertGraph(graph: Record<string, unknown>): Promise<EntityInstance<C>>;
  /** Inserts multiple entities and their nested related entities in a single transactional operation. */
  async insertGraph(graphs: Record<string, unknown>[]): Promise<EntityInstance<C>[]>;
  async insertGraph(
    input: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<EntityInstance<C> | EntityInstance<C>[]> {
    return new InsertGraphPlanner(this.state as QueryState<EntityInstance<C>>, input).execute();
  }

  /** Select single row by primary key (scalar or composite object). */
  async findById(id: unknown): Promise<EntityInstance<C> | null> {
    const pkCols = this.requirePkColumns("findById");
    const row = await this.where(buildFindByIdIr(pkCols, pkToRecord(pkCols, id))).first();
    return row ?? null;
  }

  /** Execute the query and return all matching rows, with relations loaded
   *  and the hydration function applied if one is set. */
  async toArray(): Promise<EntityInstance<C>[]> {
    const { hydrate, qe } = this.state;
    const plan = this.buildPlan({ kind: "select" });
    const compiler = getQueryCompilerOrThrow(this.state);
    const { sql, params } = compiler.compilePlan(plan);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const rows = (await qe.query(sql, params)) as Record<string, unknown>[];
    await new RelationResolver(plan, qe, rows).resolve();
    if (!hydrate) return rows as EntityInstance<C>[];
    return Promise.all(rows.map((r) => hydrate(r))) as Promise<EntityInstance<C>[]>;
  }

  /** Return the first matching row, or undefined if the result set is empty. */
  async first(): Promise<EntityInstance<C> | undefined> {
    const arr = await this.limit(1).toArray();
    return arr[0];
  }

  /** Execute a COUNT query and return rows the query would produce without limit/offset/orderBy. */
  async count(): Promise<number> {
    const { qe } = this.state;
    const compiler = getQueryCompilerOrThrow(this.state);
    const plan = this.buildPlan({ kind: "select" });
    const { sql, params } = compiler.compileResultSize(plan);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const rows = (await qe.query(sql, params)) as [{ c: number }];
    return Number(rows[0]?.c ?? 0);
  }

  /** Execute an UPDATE for the current WHERE clause and return the number of affected rows. */
  async update(set: Record<string, unknown>): Promise<number>;
  async update(
    setFn: HasRegisteredCtes<Ctes> extends true
      ? (row: EntityInstance<C>, ctes: RegisteredCtes<Ctes>) => Record<string, unknown>
      : (row: EntityInstance<C>) => Record<string, unknown>,
  ): Promise<number>;
  async update(
    setOrFn: Record<string, unknown> | ((row: any, ctes?: any) => Record<string, unknown>),
  ): Promise<number> {
    const resolved = resolveUpdateSet(
      setOrFn as Record<string, unknown> | ((row: unknown) => Record<string, unknown>),
    );
    this.state.updateSetIr = resolved.setIr;
    const { qe } = this.state;
    const compiler = getQueryCompilerOrThrow(this.state);
    const { sql, params } = compiler.compilePlan(this.buildPlan({ kind: "update", ...resolved }));
    if (!sql) return 0;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const result = await qe.run(sql, params);
    return result.changes;
  }

  /** UPDATE ... RETURNING * (when supported); returns hydrated rows. */
  async updateReturning(set: Record<string, unknown>): Promise<EntityInstance<C>[]>;
  async updateReturning(
    setFn: HasRegisteredCtes<Ctes> extends true
      ? (row: EntityInstance<C>, ctes: RegisteredCtes<Ctes>) => Record<string, unknown>
      : (row: EntityInstance<C>) => Record<string, unknown>,
  ): Promise<EntityInstance<C>[]>;
  async updateReturning(
    setOrFn: Record<string, unknown> | ((row: any, ctes?: any) => Record<string, unknown>),
  ): Promise<EntityInstance<C>[]> {
    const resolved = resolveUpdateSet(
      setOrFn as Record<string, unknown> | ((row: unknown) => Record<string, unknown>),
    );
    this.state.updateSetIr = resolved.setIr;
    const { qe, hydrate } = this.state;
    const compiler = getQueryCompilerOrThrow(this.state);
    const { sql, params } = compiler.compilePlan(
      this.buildPlan({ kind: "update", ...resolved, returning: true }),
    );
    if (!sql) return [];
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const rows = (await qe.query(sql, params)) as Record<string, unknown>[];
    if (!hydrate) return rows as EntityInstance<C>[];
    return Promise.all(rows.map((r) => hydrate(r))) as Promise<EntityInstance<C>[]>;
  }

  /** Execute a DELETE for the current WHERE clause and return the number of affected rows. */
  async delete(): Promise<number> {
    const { qe } = this.state;
    const compiler = getQueryCompilerOrThrow(this.state);
    const { sql, params } = compiler.compilePlan(this.buildPlan({ kind: "delete" }));
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const result = await qe.run(sql, params);
    return result.changes;
  }

  /** DELETE ... RETURNING * (when supported). */
  async deleteReturning(): Promise<EntityInstance<C>[]> {
    const { qe, hydrate } = this.state;
    const compiler = getQueryCompilerOrThrow(this.state);
    const { sql, params } = compiler.compilePlan(
      this.buildPlan({ kind: "delete", returning: true }),
    );
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const rows = (await qe.query(sql, params)) as Record<string, unknown>[];
    if (!hydrate) return rows as EntityInstance<C>[];
    return Promise.all(rows.map((r) => hydrate(r))) as Promise<EntityInstance<C>[]>;
  }
}

/**
 * Deferred insert returned by `insert()` / `insertMany()`.
 * Extends `QueryBuilder` so it owns its execution logic and has direct access to state.
 * Awaitable directly (no conflict handling) or chain `.onConflict(cols).doUpdate()` / `.doNothing()`.
 *
 * @example
 * await qb.insert(row);
 * await qb.insert(row).onConflict(["sku"]).doUpdate();
 * await qb.insertMany(rows).onConflict(["sku"]).doNothing();
 */
export class InsertBuilder<C extends AnyEntityClass, R>
  extends QueryBuilder<C>
  implements PromiseLike<R>
{
  private _conflictCols?: string[];
  private readonly _payload: Record<string, unknown> | Record<string, unknown>[];

  /** @internal */
  constructor(
    state: QueryState<EntityInstance<C>>,
    payload: Record<string, unknown> | Record<string, unknown>[],
  ) {
    super(state);
    this._payload = payload;
  }

  /** Store the conflict target columns; returns `this` for chaining. */
  onConflict(columns: string[]): this {
    this._conflictCols = columns;
    return this;
  }

  /** `ON CONFLICT (...) DO UPDATE SET ...` — executes the insert. */
  doUpdate(updateColumns?: string[]): Promise<R> {
    return this._execute({ conflictColumns: this._conflictCols!, action: "update", updateColumns });
  }

  /** `ON CONFLICT (...) DO NOTHING` — executes the insert. */
  doNothing(): Promise<R> {
    return this._execute({ conflictColumns: this._conflictCols!, action: "nothing" });
  }

  /** PromiseLike: allows `await insert(row)` without a conflict clause. */
  then<T1 = R, T2 = never>(
    res?: ((v: R) => T1 | PromiseLike<T1>) | null,
    rej?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this._execute().then(res, rej);
  }

  private _execute(onConflict?: OnConflictClause): Promise<R> {
    return (
      Array.isArray(this._payload)
        ? this._doInsertMany(this._payload, onConflict)
        : this._doInsert(this._payload, onConflict)
    ) as Promise<R>;
  }

  private async _doInsert(
    row: Record<string, unknown>,
    onConflict?: OnConflictClause,
  ): Promise<EntityInstance<C> | undefined> {
    const { columnNames, qe, hydrate } = this.state;
    const compiler = getQueryCompilerOrThrow(this.state);
    const cols = columnNames.filter((c) => row[c] !== undefined);
    const params = cols.map((c) => row[c]);
    const pkCols = this.state.pkColumns;
    this.state.insertIr = undefined;

    const compiled = compiler.compilePlan(
      this.buildPlan({
        kind: "insert",
        columns: cols,
        values: params,
        pk: pkCols,
        onConflict,
      }),
    );
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(compiled.sql, compiled.params);

    if (compiled.returningRow) {
      const rows = (await qe.query(compiled.sql, compiled.params)) as Record<string, unknown>[];
      const raw = rows[0];
      if (raw == null) throw new Error("insert: RETURNING returned no row");
      if (hydrate) return (await hydrate(raw)) as EntityInstance<C>;
      return raw as EntityInstance<C>;
    }

    const result = await qe.run(compiled.sql, compiled.params);
    if (pkCols.length === 0) return undefined;
    // For single auto-increment PKs use lastID; for composite PKs all values are in `row`.
    const pkRow =
      pkCols.length === 1 && result.lastID != null ? { ...row, [pkCols[0]]: result.lastID } : row;
    const whereIr = buildFindByIdIr(pkCols, pkRow);
    const inst = await this.clone().where(whereIr).first();
    if (!inst) throw new Error("insert: insert succeeded but row not found");
    return inst;
  }

  private async _doInsertMany(
    rows: Record<string, unknown>[],
    onConflict?: OnConflictClause,
  ): Promise<EntityInstance<C>[]> {
    if (rows.length === 0) return [];
    const { columnNames, qe, hydrate } = this.state;
    const compiler = getQueryCompilerOrThrow(this.state);
    const pkCols = this.state.pkColumns;

    // Collect columns in entity-defined order, keeping any column present in at least one row.
    const cols = columnNames.filter((c) => rows.some((r) => r[c] !== undefined));
    const paramRows = rows.map((r) => cols.map((c) => r[c] ?? null));
    this.state.insertIr = undefined;

    const compiled = compiler.compilePlan(
      this.buildPlan({
        kind: "insertMany",
        columns: cols,
        rows: paramRows,
        pk: pkCols,
        onConflict,
      }),
    );
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(compiled.sql, compiled.params);

    if (compiled.returningRow) {
      const returned = (await qe.query(compiled.sql, compiled.params)) as Record<string, unknown>[];
      const hydratedRows: EntityInstance<C>[] = [];
      for (const raw of returned)
        hydratedRows.push(
          hydrate ? ((await hydrate(raw)) as EntityInstance<C>) : (raw as EntityInstance<C>),
        );
      return hydratedRows;
    }

    await qe.run(compiled.sql, compiled.params);
    return [];
  }
}
