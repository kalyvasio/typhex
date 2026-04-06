/**
 * Query builder: the single place where all SQL is built and executed.
 * Provides both query (select, count) and mutation (insert, update, delete)
 * methods. All methods that hit the database return Promises
 * (except insert, which is synchronous to support save()).
 */

import type { IrNode, IrOrderBy, IrSelect, OrderDirection, JoinHint, JoinType } from "../ir/types.js";
import type { QueryExecutor } from "./db.js";
import type { RelationsMap, RelationDef } from "../entity/relations.js";
import type { AnyEntityClass, EntityInstance, SelectRow } from "../entity/entity.js";
import { resolveWhereIr, resolveOrderBy, resolveSelectIr, resolveJoinKeys } from "../parser/resolve.js";
import { resolveParamSentinels } from "../dbs/types.js";
import { buildRelationContext, resolveSelectForSql } from "./relation-context-builder.js";
import { resolveRelations } from "./relation-resolver.js";
import { whereColumnEq } from "./query-helpers.js";
import {
  getDialectOrThrow, getRootParam, getCompileOpts, buildJoinsSql,
} from "./compile-context.js";

export interface QueryBuilderInterface<C extends AnyEntityClass, T> {
  where(ir: IrNode, params?: Record<string, unknown>): QueryBuilderInterface<C, T>;
  select<U>(fn: (row: SelectRow<C>) => U): QueryBuilderInterface<C, U>;
  select(cols: string[] | IrSelect): QueryBuilderInterface<C, T>;
  orderBy(ir: IrOrderBy): QueryBuilderInterface<C, T>;
  orderBy(col: string | ((row: T) => unknown), dir?: OrderDirection): QueryBuilderInterface<C, T>;
  limit(n: number): QueryBuilderInterface<C, T>;
  offset(n: number): QueryBuilderInterface<C, T>;
  toArray(): Promise<T[]>;
}

export interface QueryState<T = unknown> {
  tableName: string;
  columnNames: string[];
  qe: QueryExecutor;
  pkColumn?: string | null;
  whereIr: IrNode | null;
  whereParams: Record<string, unknown>;
  orderBy: IrOrderBy[];
  limitNum: number | null;
  offsetNum: number | null;
  selectIr: IrSelect | null;
  relations?: RelationsMap;
  hydrate?: (row: Record<string, unknown>) => T | Promise<T>;
  resolveRelationTarget?: (rel: RelationDef) => { table: string; pk: string } | null;
  joinHints?: JoinHint[];
}

/** C = entity class (for EntityInstance<C> return types); T = current row/selected shape. */
export class QueryBuilder<C extends AnyEntityClass = AnyEntityClass, T = EntityInstance<C>> implements QueryBuilderInterface<C, T> {
  private static readonly isDebugSqlEnabled = ((): boolean => {
    const debugFlag = process?.env?.TYPHEX_DEBUG;
    return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes";
  })();

  constructor(private state: QueryState<T>) {}

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

  /** Print the SQL and parameters to stdout when TYPHEX_DEBUG is enabled. */
  private logSql(sql: string, params: unknown[]): void {
    console.log("[typhex]", sql);
    if (params.length > 0) console.log("[typhex] params:", params);
  }

  /** Set or replace the WHERE predicate. Accepts either a pre-built IR node
   *  or an arrow function that is parsed to IR at runtime. */
  where(
    predicate: IrNode | ((entity: T) => boolean),
    params?: Record<string, unknown>
  ): QueryBuilder<C, T> {
    if (params) Object.assign(this.state.whereParams, params);
    this.state.whereIr = resolveWhereIr(predicate as IrNode | ((entity: unknown) => boolean), params ? Object.keys(params) : []);
    return this;
  }

  /** Append an ORDER BY clause. Accepts a pre-built IrOrderBy, a dot-separated
   *  column string, or an arrow function parsed to a member path at runtime. */
  orderBy(ir: IrOrderBy): QueryBuilder<C, T>;
  orderBy(col: string | ((row: T) => unknown), direction?: OrderDirection): QueryBuilder<C, T>;
  orderBy(
    colOrIr: IrOrderBy | string | ((row: T) => unknown),
    direction: OrderDirection = "asc"
  ): QueryBuilder<C, T> {
    this.state.orderBy.push(resolveOrderBy(colOrIr as IrOrderBy | string | ((row: unknown) => unknown), direction));
    return this;
  }

  innerJoin(keysOrFn: string[] | ((row: T) => unknown)): QueryBuilder<C, T> {
    return this.addJoinHints(keysOrFn, "inner");
  }

  leftJoin(keysOrFn: string[] | ((row: T) => unknown)): QueryBuilder<C, T> {
    return this.addJoinHints(keysOrFn, "left");
  }

  rightJoin(keysOrFn: string[] | ((row: T) => unknown)): QueryBuilder<C, T> {
    return this.addJoinHints(keysOrFn, "right");
  }

  crossJoin(keysOrFn: string[] | ((row: T) => unknown)): QueryBuilder<C, T> {
    return this.addJoinHints(keysOrFn, "cross");
  }

  fullJoin(keysOrFn: string[] | ((row: T) => unknown)): QueryBuilder<C, T> {
    return this.addJoinHints(keysOrFn, "full");
  }

  private addJoinHints(
    keysOrFn: string[] | ((row: T) => unknown),
    joinType: JoinType
  ): QueryBuilder<C, T> {
    const relationKeys = resolveJoinKeys(keysOrFn as string[] | ((row: unknown) => unknown));
    const newHints: JoinHint[] = relationKeys.map(k => ({ relationKey: k, joinType }));
    const clone = this.clone();
    clone.state = {
      ...clone.state,
      joinHints: [...(clone.state.joinHints ?? []), ...newHints],
    };
    return clone;
  }

  /** Set the maximum number of rows to return. */
  limit(n: number): QueryBuilder<C, T> {
    this.state.limitNum = n;
    return this;
  }

  /** Set the number of rows to skip before returning results. */
  offset(n: number): QueryBuilder<C, T> {
    this.state.offsetNum = n;
    return this;
  }

  /** Set the SELECT projection. Accepts an arrow function (parsed to IrSelect at runtime),
   *  a plain column-name array, or a raw IrSelect node. */
  select<U>(fn: (row: SelectRow<C>) => U): QueryBuilder<C, U>;
  select(columnsOrIr: string[] | IrSelect): QueryBuilder<C, T>;
  select(
    columnsOrIr: string[] | IrSelect | ((row: SelectRow<C>) => Record<string, unknown>)
  ): QueryBuilder<C, unknown> {
    this.state.selectIr = resolveSelectIr(columnsOrIr as string[] | IrSelect | ((row: unknown) => Record<string, unknown>));
    return this as unknown as QueryBuilder<C, unknown>;
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

  /**
   * Insert row and return the hydrated instance.
   * If dialect sets returningRow on compile result, use driver.query() and the returned row; else run then fetch by pk.
   */
  async insert(row: Record<string, unknown>): Promise<EntityInstance<C>> {
    const { tableName, columnNames, qe, pkColumn, hydrate } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const cols = columnNames.filter((c) => row[c] !== undefined);
    const params = cols.map((c) => row[c]);
    const pk = pkColumn ?? "id";

    const compiled = dialect.compileInsert(tableName, cols, params, pk);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(compiled.sql, compiled.params);

    if (compiled.returningRow) {
      const rows = (await qe.query(compiled.sql, compiled.params)) as Record<string, unknown>[];
      const raw = rows[0];
      if (raw == null) throw new Error("insert: RETURNING returned no row");
      if (hydrate) return (await hydrate(raw)) as EntityInstance<C>;
      return raw as EntityInstance<C>;
    }

    const result = await qe.run(compiled.sql, compiled.params);
    const lastId = result.lastID ?? 0;
    const inst = await this.clone().where(whereColumnEq(pk, lastId)).first();
    if (!inst) throw new Error("insert: insert succeeded but row not found");
    return inst;
  }

  /** Select single row by primary key. Replaces Entity.findById(). */
  async findById(id: number): Promise<EntityInstance<C> | null> {
    const pkColumn = this.state.pkColumn ?? "id";
    const row = await this.where(whereColumnEq(pkColumn, id)).first();
    return row ?? null;
  }

  /** Execute the query and return all matching rows, with relations loaded
   *  and the hydration function applied if one is set. */
  async toArray(): Promise<EntityInstance<C>[]> {
    const { hydrate, qe } = this.state;
    const ctx = buildRelationContext(
      this.state.selectIr, this.state.relations, this.state.whereIr,
      this.state.pkColumn, getRootParam(this.state)
    );
    const rows = await this.executeMainQuery(resolveSelectForSql(this.state.selectIr, ctx.columnPaths, ctx.columnAliases));
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
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const joinsSql = buildJoinsSql(this.state, dialect);
    const { sql, params: runParams } = dialect.compileCount(tableName, whereSql, params, joinsSql || undefined);
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
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params: whereParams } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const { sql, params } = dialect.compileUpdate(tableName, set, columnNames, whereSql, whereParams);
    if (!sql) return 0;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const result = await qe.run(sql, params);
    return result.changes;
  }

  /** Execute a DELETE for the current WHERE clause and return the number of affected rows. */
  async delete(): Promise<number> {
    const { tableName, qe } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const { sql, params: runParams } = dialect.compileDelete(tableName, whereSql, params);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, runParams);
    const result = await qe.run(sql, runParams);
    return result.changes;
  }

  /** Compile and run the main SELECT query, incorporating WHERE, JOINs, ORDER BY,
   *  LIMIT, OFFSET, and the resolved SELECT list. */
  private async executeMainQuery(selectForSql: IrSelect | null): Promise<Record<string, unknown>[]> {
    const { tableName, columnNames, qe } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params: whereParams } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const selectList = dialect.compileSelectList(selectForSql, columnNames, opts);
    const orderBySql = dialect.compileOrderBy(this.state.orderBy, opts);
    const joinsSql = buildJoinsSql(this.state, dialect);
    const { sql, params } = dialect.compileSelect({
      table: tableName,
      selectList,
      whereSql,
      whereParams,
      orderBySql,
      limitNum: this.state.limitNum,
      offsetNum: this.state.offsetNum,
      joinsSql: joinsSql || undefined,
    });
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    return qe.query(sql, params) as Promise<Record<string, unknown>[]>;
  }
}
