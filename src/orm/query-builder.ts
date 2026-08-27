/**
 * Query clauses and terminals for selecting and mutating entity rows.
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
import { RelationResolver } from "./helpers/relations/relation-resolver.js";
import { RelationFetchCompiler } from "./helpers/relations/relation-fetcher.js";
import { buildFindByIdIr, pkToRecord } from "./query-helpers.js";
import { getQueryCompilerOrThrow } from "./helpers/query-plan/query-plan.js";
import { InsertGraphPlanner } from "./helpers/insert-graph/insert-graph-planner.js";
import { QueryState, type CapturedSubquery, type QueryStateInit } from "./query-state.js";
import { DEFAULT_ROW_PARAM } from "../arrow/constants.js";
import { buildQueryPlan, logSql } from "./query-execution-context.js";
import { InsertBuilder } from "./insert-builder.js";
import { Statement, type SqlAndParams } from "./statement.js";

export { InsertBuilder } from "./insert-builder.js";
export { Statement, type RelationFetchSql, type SqlAndParams } from "./statement.js";

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
  protected state: QueryState<T>;

  /** @internal */
  constructor(state: QueryState<T> | QueryStateInit<T>) {
    this.state = state instanceof QueryState ? state : new QueryState(state);
  }

  /** Return a copy of this builder whose mutable query state is independent. */
  clone(): QueryBuilder<C, T, Ctes, FromKind> {
    return new QueryBuilder(this.state.clone());
  }

  private buildPlan(operation: Parameters<typeof buildQueryPlan>[1]) {
    return buildQueryPlan(this.state, operation);
  }

  private logSql(sql: string, params: unknown[]): void {
    logSql(sql, params);
  }

  protected requirePkColumns(context: string): string[] {
    if (this.state.pkColumns.length === 0) {
      throw new Error(`[typhex] ${context}: entity "${this.state.tableName}" has no primary key`);
    }
    return this.state.pkColumns;
  }

  private static splitParams(params?: Record<string, unknown> | null) {
    const sqlParams: Record<string, unknown> = {};
    const subqueryParams: Record<string, CapturedSubquery> = {};

    for (const [key, value] of Object.entries(params ?? {})) {
      if (value instanceof QueryBuilder) {
        subqueryParams[key] = { state: value.state.clone() };
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
    const next = this.clone();
    const { sqlParams, subqueryParams } = QueryBuilder.splitParams(params);
    const previousWhere = next.state.whereIr;
    next.state.whereIr = resolveWhereIr(
      predicate as IrWhere | ((entity: unknown) => boolean),
      params ? Object.keys(params) : [],
      Object.keys(subqueryParams),
    );
    next.state.whereParams = sqlParams;
    next.replacePredicateSubqueries(previousWhere, subqueryParams, [
      next.state.havingIr,
      next.state.orderBy,
      next.state.selectIr,
    ]);
    return next as this;
  }

  /** @internal — used by the TypeScript transformer */
  orderBy(ir: IrOrderBy, params?: Record<string, unknown> | null): this;
  /** Append an ORDER BY clause. Accepts a dot-separated column string or
   *  an arrow function parsed to a member path at runtime. */
  orderBy(col: string | ((row: T) => unknown), direction?: OrderDirection): this;
  orderBy(
    colOrIr: IrOrderBy | string | ((row: T) => unknown),
    second: OrderDirection | Record<string, unknown> | null = "asc",
  ): this {
    const next = this.clone();
    if (isIrOrderBy(colOrIr)) {
      return next.addOrderByIr(colOrIr, typeof second === "object" ? second : null) as this;
    }
    const direction = typeof second === "string" ? second : "asc";
    return next.addOrderByInput(colOrIr, direction) as this;
  }

  private addOrderByIr(ir: IrOrderBy, params: Record<string, unknown> | null): this {
    this.addInlineParams(params);
    this.state.orderBy.push(ir);
    return this;
  }

  private addOrderByInput(input: string | ((row: T) => unknown), direction: OrderDirection): this {
    const paramKeys = Object.keys(this.state.inlineParams ?? {});
    this.state.orderBy.push(
      resolveOrderBy(input as string | ((row: unknown) => unknown), direction, paramKeys),
    );
    return this;
  }

  private addInlineParams(params: Record<string, unknown> | null): string[] {
    const { sqlParams, subqueryParams: captured } = QueryBuilder.splitParams(params);
    Object.assign(this.state.subqueryParams, captured);
    if (params !== null) {
      this.state.inlineParams = { ...this.state.inlineParams, ...sqlParams };
    }
    return Object.keys(sqlParams);
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
    const next = this.clone();
    if (QueryBuilder.isEntityClass(keysOrFnOrEntity)) {
      if (!onFn) {
        throw new Error(`${joinType}Join(entity): ON callback is required`);
      }
      const onIr = resolveJoinOnIr(joinType, onFn as (joined: unknown, row: unknown) => boolean);
      next.state.entityJoinHints = [
        ...(next.state.entityJoinHints ?? []),
        { joinType, entity: keysOrFnOrEntity, onIr },
      ];
      return next as this;
    }
    return this.addJoinHints(keysOrFnOrEntity as string[] | ((row: T) => unknown), joinType);
  }

  private static isEntityClass(value: unknown): value is AnyEntityClass {
    if (typeof value !== "function" || value == null) return false;
    const cls = value as unknown as AnyEntityClass;
    return typeof cls.table?._table === "string";
  }

  private addJoinHints(keysOrFn: string[] | ((row: T) => unknown), joinType: JoinType): this {
    const next = this.clone();
    const relationKeys = resolveJoinKeys(keysOrFn as string[] | ((row: unknown) => unknown));
    const newHints: JoinHint[] = relationKeys.map((k) => ({ relationKey: k, joinType }));
    next.state.joinHints = [...(next.state.joinHints ?? []), ...newHints];
    return next as this;
  }

  /** Set the maximum number of rows to return. */
  limit(n: number): this {
    const next = this.clone();
    next.state.limitNum = n;
    return next as this;
  }

  /** Set the number of rows to skip before returning results. */
  offset(n: number): this {
    const next = this.clone();
    next.state.offsetNum = n;
    return next as this;
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
    params: Record<string, unknown> | null = null,
  ): QueryBuilder<C, unknown, Ctes> {
    const next = this.clone();
    const paramKeys = next.addInlineParams(params);
    next.state.selectIr = resolveSelectIr(
      columnsOrIr as string[] | IrSelect | ((row: unknown) => Record<string, unknown>),
      paramKeys,
    );
    return next as QueryBuilder<C, unknown, Ctes>;
  }

  /** Adds a GROUP BY clause. Accepts column names, index numbers, or an arrow function selecting group-by fields. */
  groupBy(
    columnOrFn: string | string[] | number | number[] | ((row: EntityInstance<C>) => unknown),
    ...rest: (string | number)[]
  ): this {
    const next = this.clone();
    const entries = resolveGroupByPaths(
      columnOrFn as string | string[] | number | number[] | ((row: unknown) => unknown),
      ...rest,
    );
    const nextSelectIr = next.state.selectIr ?? { param: DEFAULT_ROW_PARAM, paths: [] };
    const memberPaths = entries.filter((e): e is string[] => Array.isArray(e));
    next.state.selectIr = {
      ...nextSelectIr,
      paths: nextSelectIr.paths.length > 0 ? nextSelectIr.paths : memberPaths,
      groupBy: entries,
    };
    return next as this;
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
    const next = this.clone();
    const { sqlParams, subqueryParams } = QueryBuilder.splitParams(params);
    const previousHaving = next.state.havingIr;
    next.state.havingIr = resolveHavingIr(
      predicate as IrHaving | ((entity: unknown) => boolean),
      params ? Object.keys(params) : [],
      Object.keys(subqueryParams),
    );
    next.state.havingParams = sqlParams;
    next.replacePredicateSubqueries(previousHaving, subqueryParams, [
      next.state.whereIr,
      next.state.orderBy,
      next.state.selectIr,
    ]);
    return next as this;
  }

  private replacePredicateSubqueries(
    previousPredicate: IrWhere | null,
    subqueryParams: Record<string, CapturedSubquery>,
    otherIr: unknown[],
  ): void {
    const previousKeys = QueryBuilder.collectSubqueryRefs(previousPredicate);
    const retainedKeys = QueryBuilder.collectSubqueryRefs(otherIr);
    for (const key of previousKeys) {
      if (!retainedKeys.has(key)) delete this.state.subqueryParams[key];
    }
    Object.assign(this.state.subqueryParams, subqueryParams);
  }

  private static collectSubqueryRefs(value: unknown, refs = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
      for (const item of value) QueryBuilder.collectSubqueryRefs(item, refs);
      return refs;
    }
    if (value == null || typeof value !== "object") return refs;

    const node = value as Record<string, unknown>;
    if (node.kind === "const") return refs;
    if (node.kind === "subqueryRef") {
      if (typeof node.key === "string") refs.add(node.key);
      return refs;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "whereParams") QueryBuilder.collectSubqueryRefs(child, refs);
    }
    return refs;
  }

  /** Partial update: SET the given columns, then re-fetch and return the row,
   *  or null if no matching row is found after the update. */
  async patch(set: Record<string, unknown>): Promise<EntityInstance<C> | null> {
    const query = this.clone();
    await query.runUpdate(resolveUpdateSet(set), false);
    const fresh = new QueryBuilder<C, T>({
      ...query.state,
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
      this.state.clone() as QueryState<EntityInstance<C>>,
      row,
      (inserted) => this.fetchInsertedRow(inserted),
    );
  }

  /** Insert multiple rows in one statement. Awaitable directly, or chain `.onConflict(cols).doUpdate()` / `.doNothing()`. */
  insertMany(rows: Record<string, unknown>[]): InsertBuilder<C, EntityInstance<C>[]> {
    return new InsertBuilder<C, EntityInstance<C>[]>(
      this.state.clone() as QueryState<EntityInstance<C>>,
      rows,
      (inserted) => this.fetchInsertedRow(inserted),
    );
  }

  private async fetchInsertedRow(
    row: Record<string, unknown>,
  ): Promise<EntityInstance<C> | undefined> {
    const pkColumns = this.requirePkColumns("insert");
    return new QueryBuilder<C, EntityInstance<C>>(
      this.state.clone() as QueryState<EntityInstance<C>>,
    )
      .where(buildFindByIdIr(pkColumns, row))
      .first();
  }

  /** Inserts an entity and its nested related entities in a single transactional operation. */
  async insertGraph(graph: Record<string, unknown>): Promise<EntityInstance<C>>;
  /** Inserts multiple entities and their nested related entities in a single transactional operation. */
  async insertGraph(graphs: Record<string, unknown>[]): Promise<EntityInstance<C>[]>;
  async insertGraph(
    input: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<EntityInstance<C> | EntityInstance<C>[]> {
    return new InsertGraphPlanner(
      this.state.clone() as QueryState<EntityInstance<C>>,
      input,
    ).execute();
  }

  /** Select one row by primary key.
   *  Await to execute, or call `toSql()` to compile without executing. */
  findById(id: unknown): Statement<EntityInstance<C> | null> {
    const pkCols = this.requirePkColumns("findById");
    const query = this.where(buildFindByIdIr(pkCols, pkToRecord(pkCols, id))).limit(1);
    return new Statement(
      async () => (await query.runSelect())[0] ?? null,
      () => query.compileSelect(),
    );
  }

  /** All matching rows, with relations loaded and hydration applied.
   *  Await to execute, or call `toSql()` to compile without executing. */
  toArray(): Statement<EntityInstance<C>[]> {
    const query = this.clone();
    return new Statement(
      () => query.runSelect(),
      () => query.compileSelect(),
    );
  }

  /** The first matching row, or undefined if the result set is empty.
   *  Await to execute, or call `toSql()` to compile without executing. */
  first(): Statement<EntityInstance<C> | undefined> {
    const query = this.limit(1);
    return new Statement(
      async () => (await query.runSelect())[0],
      () => query.compileSelect(),
    );
  }

  /** The COUNT of rows the query would produce without limit/offset/orderBy.
   *  Await to execute, or call `toSql()` to compile without executing. */
  count(): Statement<number> {
    const query = this.clone();
    return new Statement(
      () => query.runCount(),
      () => query.compileCount(),
    );
  }

  private async runSelect(): Promise<EntityInstance<C>[]> {
    const plan = this.buildPlan({ kind: "select" });
    const compiled = getQueryCompilerOrThrow(this.state).compilePlan(plan);
    const rows = await this.queryRows(compiled);
    await new RelationResolver(plan, this.state.qe, rows).resolve();
    return this.hydrateRows(rows);
  }

  private async runCount(): Promise<number> {
    const rows = (await this.queryRows(this.compileCount())) as [{ c: number }];
    return Number(rows[0]?.c ?? 0);
  }

  private compileSelect(): SqlAndParams {
    const plan = this.buildPlan({ kind: "select" });
    const { sql, params } = getQueryCompilerOrThrow(this.state).compilePlan(plan);
    if (plan.relationFetches.length === 0) return { sql, params };
    const relationFetches = new RelationFetchCompiler(
      this.state.qe,
      plan.relationFetches,
      plan.skipLoadFor,
    ).compile();
    return relationFetches.length > 0 ? { sql, params, relationFetches } : { sql, params };
  }

  private compileCount(): SqlAndParams {
    const compiler = getQueryCompilerOrThrow(this.state);
    const { sql, params } = compiler.compileResultSize(this.buildPlan({ kind: "select" }));
    return { sql, params };
  }

  private compileDelete(): SqlAndParams {
    const compiler = getQueryCompilerOrThrow(this.state);
    const { sql, params } = compiler.compilePlan(this.buildPlan({ kind: "delete" }));
    return { sql, params };
  }

  /** UPDATE the current WHERE clause; resolves to the number of affected rows.
   *  Await to execute, or call `toSql()` to compile without executing. */
  update(set: Record<string, unknown>): Statement<number>;
  update(
    setFn: HasRegisteredCtes<Ctes> extends true
      ? (row: EntityInstance<C>, ctes: RegisteredCtes<Ctes>) => Record<string, unknown>
      : (row: EntityInstance<C>) => Record<string, unknown>,
  ): Statement<number>;
  update(
    setOrFn: Record<string, unknown> | ((row: any, ctes?: any) => Record<string, unknown>),
  ): Statement<number> {
    const query = this.clone();
    const resolved = resolveUpdateSet(
      setOrFn as Record<string, unknown> | ((row: unknown) => Record<string, unknown>),
    );
    return new Statement(
      () => query.runUpdate(resolved, false),
      () => query.compileUpdate(resolved, false),
    );
  }

  private async runUpdate(
    resolved: ReturnType<typeof resolveUpdateSet>,
    returning: false,
  ): Promise<number>;
  private async runUpdate(
    resolved: ReturnType<typeof resolveUpdateSet>,
    returning: true,
  ): Promise<EntityInstance<C>[]>;
  private async runUpdate(
    resolved: ReturnType<typeof resolveUpdateSet>,
    returning: boolean,
  ): Promise<number | EntityInstance<C>[]> {
    const { sql, params } = this.compileUpdate(resolved, returning);
    if (returning) {
      if (!sql) return [];
      return this.hydrateRows(await this.queryRows({ sql, params }));
    }
    if (!sql) return 0;
    return this.runMutation({ sql, params });
  }

  private compileUpdate(
    resolved: ReturnType<typeof resolveUpdateSet>,
    returning: boolean,
  ): SqlAndParams {
    this.state.updateSetIr = resolved.setIr;
    const { sql, params } = getQueryCompilerOrThrow(this.state).compilePlan(
      this.buildPlan({ kind: "update", ...resolved, returning }),
    );
    return { sql, params };
  }

  /** UPDATE ... RETURNING * (when supported).
   *  Await to execute, or call `toSql()` to compile without executing. */
  updateReturning(set: Record<string, unknown>): Statement<EntityInstance<C>[]>;
  updateReturning(
    setFn: HasRegisteredCtes<Ctes> extends true
      ? (row: EntityInstance<C>, ctes: RegisteredCtes<Ctes>) => Record<string, unknown>
      : (row: EntityInstance<C>) => Record<string, unknown>,
  ): Statement<EntityInstance<C>[]>;
  updateReturning(
    setOrFn: Record<string, unknown> | ((row: any, ctes?: any) => Record<string, unknown>),
  ): Statement<EntityInstance<C>[]> {
    const query = this.clone();
    const resolved = resolveUpdateSet(
      setOrFn as Record<string, unknown> | ((row: unknown) => Record<string, unknown>),
    );
    return new Statement(
      () => query.runUpdate(resolved, true),
      () => query.compileUpdate(resolved, true),
    );
  }

  /** DELETE for the current WHERE clause; resolves to the number of affected rows.
   *  Await to execute, or call `toSql()` to compile without executing. */
  delete(): Statement<number> {
    const query = this.clone();
    return new Statement(
      () => query.runDelete(),
      () => query.compileDelete(),
    );
  }

  private async runDelete(): Promise<number> {
    return this.runMutation(this.compileDelete());
  }

  /** DELETE ... RETURNING * (when supported).
   *  Await to execute, or call `toSql()` to compile without executing. */
  deleteReturning(): Statement<EntityInstance<C>[]> {
    const query = this.clone();
    return new Statement(
      () => query.runDeleteReturning(),
      () => query.compileDeleteReturning(),
    );
  }

  private async runDeleteReturning(): Promise<EntityInstance<C>[]> {
    return this.hydrateRows(await this.queryRows(this.compileDeleteReturning()));
  }

  private compileDeleteReturning(): SqlAndParams {
    const { sql, params } = getQueryCompilerOrThrow(this.state).compilePlan(
      this.buildPlan({ kind: "delete", returning: true }),
    );
    return { sql, params };
  }

  private async queryRows(compiled: SqlAndParams): Promise<Record<string, unknown>[]> {
    this.logSql(compiled.sql, compiled.params);
    return this.state.qe.query(compiled.sql, compiled.params) as Promise<Record<string, unknown>[]>;
  }

  private async runMutation(compiled: SqlAndParams): Promise<number> {
    this.logSql(compiled.sql, compiled.params);
    return (await this.state.qe.run(compiled.sql, compiled.params)).changes;
  }

  private hydrateRows(rows: Record<string, unknown>[]): Promise<EntityInstance<C>[]> {
    const { hydrate } = this.state;
    if (!hydrate) return Promise.resolve(rows as EntityInstance<C>[]);
    return Promise.all(rows.map((row) => hydrate(row))) as Promise<EntityInstance<C>[]>;
  }
}
