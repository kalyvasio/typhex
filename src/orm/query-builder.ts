/**
 * Query builder: the single place where all SQL is built and executed.
 * Provides both query (select, count) and mutation (insert, update, delete)
 * methods. All methods that hit the database return Promises
 * (except insert, which is synchronous to support save()).
 */

import {
  type IrNode,
  type IrOrderBy,
  type IrSelect,
  type OrderDirection,
  type JoinHint,
  type JoinType,
} from "../ir/types.js";
import type { QueryExecutor } from "./db.js";
import type { RelationsMap, RelationDef } from "../entity/relations.js";
import type { AnyEntityClass, EntityInstance, SelectRow } from "../entity/entity.js";
import {
  resolveWhereIr,
  resolveOrderBy,
  resolveSelectIr,
  resolveGroupByPaths,
  resolveJoinKeys,
} from "../parser/resolve.js";
import {
  resolveParamSentinels,
  type OnConflictClause,
  type ExpandPlaceholdersResult,
  type DialectImpl,
} from "../dbs/types.js";
import {
  buildRelationContext,
  resolveSelectForSql,
} from "./helpers/relations/relation-context-builder.js";
import { resolveRelations } from "./helpers/relations/relation-resolver.js";
import { buildFindByIdIr, pkToRecord } from "./query-helpers.js";
import {
  DEFAULT_ROW_PARAM,
  getDialectOrThrow,
  getRootParam,
  getCompileOpts,
  buildJoinsSql,
} from "./compile-context.js";
import { InsertGraphPlanner } from "./helpers/insert-graph/insert-graph-planner.js";

/** @internal — internal builder state */
export interface QueryState<T = unknown> {
  tableName: string;
  columnNames: string[];
  qe: QueryExecutor;
  /** Primary key column names (single or composite). */
  pkColumns?: string[];
  whereIr: IrNode | null;
  whereParams: Record<string, unknown>;
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
  havingIr?: IrNode | null;
  havingParams?: Record<string, unknown>;
  entity?: AnyEntityClass;
}

/** C = entity class (for EntityInstance<C> return types); T = current row/selected shape. */
export class QueryBuilder<C extends AnyEntityClass = AnyEntityClass, T = EntityInstance<C>> {
  /** @internal */
  protected static readonly isDebugSqlEnabled = ((): boolean => {
    const debugFlag = process?.env?.TYPHEX_DEBUG;
    return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes";
  })();

  /** @internal */
  protected state: QueryState<T>;
  /** @internal */
  constructor(state: QueryState<T>) {
    this.state = state;
  }

  /** Return a shallow copy of this builder with mutable state (params, orderBy) deep-copied,
   *  so chained calls do not mutate the original. */
  clone(): QueryBuilder<C, T> {
    return new QueryBuilder({
      ...this.state,
      whereParams: { ...this.state.whereParams },
      orderBy: [...this.state.orderBy],
      joinHints: this.state.joinHints ? [...this.state.joinHints] : undefined,
    });
  }

  /** @internal — Print the SQL and parameters to stdout when TYPHEX_DEBUG is enabled. */
  protected logSql(sql: string, params: unknown[]): void {
    console.log("[typhex]", sql);
    if (params.length > 0) console.log("[typhex] params:", params);
  }

  /** @internal — used by the TypeScript transformer */
  where(predicate: IrNode, params?: Record<string, unknown>): this;
  /** Set or replace the WHERE predicate. Accepts an arrow function that is parsed to IR at runtime. */
  where(predicate: (entity: T) => boolean, params?: Record<string, unknown>): this;
  where(predicate: IrNode | ((entity: T) => boolean), params?: Record<string, unknown>): this {
    if (params) Object.assign(this.state.whereParams, params);
    this.state.whereIr = resolveWhereIr(
      predicate as IrNode | ((entity: unknown) => boolean),
      params ? Object.keys(params) : [],
    );
    return this;
  }

  /** @internal — used by the TypeScript transformer */
  orderBy(ir: IrOrderBy): this;
  /** Append an ORDER BY clause. Accepts a dot-separated column string or
   *  an arrow function parsed to a member path at runtime. */
  orderBy(col: string | ((row: T) => unknown), direction?: OrderDirection): this;
  orderBy(
    colOrIr: IrOrderBy | string | ((row: T) => unknown),
    direction: OrderDirection = "asc",
  ): this {
    this.state.orderBy.push(
      resolveOrderBy(colOrIr as IrOrderBy | string | ((row: unknown) => unknown), direction),
    );
    return this;
  }

  /** Adds an INNER JOIN for the given relation keys or accessor function. */
  innerJoin(keysOrFn: string[] | ((row: T) => unknown)): this {
    return this.addJoinHints(keysOrFn, "inner");
  }

  /** Adds a LEFT JOIN for the given relation keys or accessor function. */
  leftJoin(keysOrFn: string[] | ((row: T) => unknown)): this {
    return this.addJoinHints(keysOrFn, "left");
  }

  /** Adds a RIGHT JOIN for the given relation keys or accessor function. */
  rightJoin(keysOrFn: string[] | ((row: T) => unknown)): this {
    return this.addJoinHints(keysOrFn, "right");
  }

  /** Adds a CROSS JOIN for the given relation keys or accessor function. */
  crossJoin(keysOrFn: string[] | ((row: T) => unknown)): this {
    return this.addJoinHints(keysOrFn, "cross");
  }

  /** Adds a FULL OUTER JOIN for the given relation keys or accessor function. */
  fullJoin(keysOrFn: string[] | ((row: T) => unknown)): this {
    return this.addJoinHints(keysOrFn, "full");
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

  /** Sets the SELECT projection using an arrow function parsed at runtime or by the TypeScript transformer. */
  select<U>(fn: (row: SelectRow<C>) => U): QueryBuilder<C, U>;
  /** Sets the SELECT projection using an explicit list of column names. */
  select(columns: string[]): QueryBuilder<C, T>;
  /** @internal — used by the TypeScript transformer */
  select(ir: IrSelect): QueryBuilder<C, T>;
  select(
    columnsOrIr: string[] | IrSelect | ((row: SelectRow<C>) => Record<string, unknown>),
  ): QueryBuilder<C, unknown> {
    this.state.selectIr = resolveSelectIr(
      columnsOrIr as string[] | IrSelect | ((row: unknown) => Record<string, unknown>),
    );
    return this;
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
  having(predicate: IrNode, params?: Record<string, unknown>): this;
  /** Adds a HAVING clause to filter aggregated groups (use together with `groupBy`). */
  having(predicate: (row: EntityInstance<C>) => boolean, params?: Record<string, unknown>): this;
  having(
    predicate: IrNode | ((row: EntityInstance<C>) => boolean),
    params?: Record<string, unknown>,
  ): this {
    this.state.havingIr = resolveWhereIr(
      predicate as IrNode | ((entity: unknown) => boolean),
      params ? Object.keys(params) : [],
    );
    this.state.havingParams = params ?? {};
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
    });
    return (await fresh.first()) ?? null;
  }

  /** Insert a single row. Awaitable directly, or chain `.onConflict(cols).doUpdate()` / `.doNothing()`. */
  insert(row: Record<string, unknown>): InsertBuilder<C, EntityInstance<C>> {
    return new InsertBuilder<C, EntityInstance<C>>(
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
    const pkCols = this.state.pkColumns ?? ["id"];
    const row = await this.where(buildFindByIdIr(pkCols, pkToRecord(pkCols, id))).first();
    return row ?? null;
  }

  /** Execute the query and return all matching rows, with relations loaded
   *  and the hydration function applied if one is set. */
  async toArray(): Promise<EntityInstance<C>[]> {
    const { hydrate, qe } = this.state;
    const ctx = buildRelationContext(
      this.state.selectIr,
      this.state.relations,
      this.state.whereIr,
      this.state.pkColumns ?? ["id"],
      getRootParam(this.state),
    );
    const rows = await this.executeMainQuery(
      resolveSelectForSql(this.state.selectIr, ctx.columnPaths, ctx.columnAliases),
    );
    await resolveRelations(ctx, this.state.selectIr, qe, rows);
    if (!hydrate) return rows as EntityInstance<C>[];
    return Promise.all(rows.map((r) => hydrate(r))) as Promise<EntityInstance<C>[]>;
  }

  /** Return the first matching row, or undefined if the result set is empty. */
  async first(): Promise<EntityInstance<C> | undefined> {
    const arr = await this.limit(1).toArray();
    return arr[0];
  }

  /** Execute a COUNT query and return the total number of rows matching the current WHERE clause. */
  async count(): Promise<number> {
    const { tableName, qe } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params } = this.expandWithSentinels(
      dialect,
      whereResult.sql,
      whereResult.params,
      this.state.whereParams,
    );
    const joinsSql = buildJoinsSql(this.state, dialect);
    const { sql, params: runParams } = dialect.compileCount(
      tableName,
      whereSql,
      params,
      joinsSql || undefined,
    );
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, runParams);
    const rows = (await qe.query(sql, runParams)) as [{ c: number }];
    return Number(rows[0]?.c ?? 0);
  }

  /** Execute an UPDATE for the current WHERE clause and return the number of affected rows. */
  async update(set: Record<string, unknown>): Promise<number> {
    const { tableName, columnNames, qe } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params: whereParams } = this.expandWithSentinels(
      dialect,
      whereResult.sql,
      whereResult.params,
      this.state.whereParams,
    );
    const { sql, params } = dialect.compileUpdate(
      tableName,
      set,
      columnNames,
      whereSql,
      whereParams,
    );
    if (!sql) return 0;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const result = await qe.run(sql, params);
    return result.changes;
  }

  /** UPDATE ... RETURNING * (when supported); returns hydrated rows. */
  async updateReturning(set: Record<string, unknown>): Promise<EntityInstance<C>[]> {
    const { tableName, columnNames, qe, hydrate } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params: whereParams } = dialect.expandPlaceholders(
      whereResult.sql,
      resolved,
    );
    const { sql, params } = dialect.compileUpdate(
      tableName,
      set,
      columnNames,
      whereSql,
      whereParams,
      { returning: true },
    );
    if (!sql) return [];
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const rows = (await qe.query(sql, params)) as Record<string, unknown>[];
    if (!hydrate) return rows as EntityInstance<C>[];
    return Promise.all(rows.map((r) => hydrate(r))) as Promise<EntityInstance<C>[]>;
  }

  /** Execute a DELETE for the current WHERE clause and return the number of affected rows. */
  async delete(): Promise<number> {
    const { tableName, qe } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params } = this.expandWithSentinels(
      dialect,
      whereResult.sql,
      whereResult.params,
      this.state.whereParams,
    );
    const { sql, params: runParams } = dialect.compileDelete(tableName, whereSql, params);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, runParams);
    const result = await qe.run(sql, runParams);
    return result.changes;
  }

  /** DELETE ... RETURNING * (when supported). */
  async deleteReturning(): Promise<EntityInstance<C>[]> {
    const { tableName, qe, hydrate } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const { sql, params: runParams } = dialect.compileDelete(tableName, whereSql, params, {
      returning: true,
    });
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, runParams);
    const rows = (await qe.query(sql, runParams)) as Record<string, unknown>[];
    if (!hydrate) return rows as EntityInstance<C>[];
    return Promise.all(rows.map((r) => hydrate(r))) as Promise<EntityInstance<C>[]>;
  }

  /** Compile and run the main SELECT query, incorporating WHERE, JOINs, ORDER BY,
   *  LIMIT, OFFSET, and the resolved SELECT list. */
  private async executeMainQuery(
    selectForSql: IrSelect | null,
  ): Promise<Record<string, unknown>[]> {
    const { tableName, columnNames } = this.state;
    const qe = this.state.qe;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params: whereParams } = this.expandWithSentinels(
      dialect,
      whereResult.sql,
      whereResult.params,
      this.state.whereParams,
    );
    const selectList = dialect.compileSelectList(selectForSql, columnNames, opts);
    const orderBySql = dialect.compileOrderBy(this.state.orderBy, opts);
    const joinsSql = buildJoinsSql(this.state, dialect);
    let havingSqlResult: { sql: string; params: unknown[] } | null = null;
    if (this.state.havingIr) {
      const havingResult = dialect.compileWhere(this.state.havingIr, opts);
      havingSqlResult = this.expandWithSentinels(
        dialect,
        havingResult.sql,
        havingResult.params,
        this.state.havingParams ?? {},
        whereParams.length + 1,
      );
    }
    const { sql, params } = dialect.compileSelect({
      table: tableName,
      selectList,
      whereSql,
      whereParams,
      orderBySql,
      limitNum: this.state.limitNum,
      offsetNum: this.state.offsetNum,
      joinsSql: joinsSql || undefined,
      groupBy: selectForSql?.groupBy,
      compileOpts: opts,
      havingSql: havingSqlResult?.sql,
      havingParams: havingSqlResult?.params,
    });
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    return qe.query(sql, params) as Promise<Record<string, unknown>[]>;
  }

  /** @internal */
  protected expandWithSentinels(
    dialect: DialectImpl,
    sql: string,
    params: unknown[],
    paramValues: Record<string, unknown>,
    startIdx?: number,
  ): ExpandPlaceholdersResult {
    return dialect.expandPlaceholders(sql, resolveParamSentinels(params, paramValues), startIdx);
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
  ): Promise<EntityInstance<C>> {
    const { tableName, columnNames, qe, hydrate } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const cols = columnNames.filter((c) => row[c] !== undefined);
    const params = cols.map((c) => row[c]);
    const pkCols = this.state.pkColumns ?? ["id"];

    const compiled = dialect.compileInsert(tableName, cols, params, pkCols, onConflict);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(compiled.sql, compiled.params);

    if (compiled.returningRow) {
      const rows = (await qe.query(compiled.sql, compiled.params)) as Record<string, unknown>[];
      const raw = rows[0];
      if (raw == null) throw new Error("insert: RETURNING returned no row");
      if (hydrate) return (await hydrate(raw)) as EntityInstance<C>;
      return raw as EntityInstance<C>;
    }

    const result = await qe.run(compiled.sql, compiled.params);
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
    const { tableName, columnNames, qe, hydrate } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const pkCols = this.state.pkColumns ?? ["id"];

    // Collect columns in entity-defined order, keeping any column present in at least one row.
    const cols = columnNames.filter((c) => rows.some((r) => r[c] !== undefined));
    const paramRows = rows.map((r) => cols.map((c) => r[c] ?? null));

    const compiled = dialect.compileInsertMany(tableName, cols, paramRows, pkCols, onConflict);
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
