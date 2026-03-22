/**
 * Query builder: the single place where all SQL is built and executed.
 * Provides both query (select, count) and mutation (insert, update, delete)
 * methods. All methods that hit the database return Promises
 * (except insert, which is synchronous to support save()).
 */

import type { IrNode, IrOrderBy, IrSelect } from "../ir/types.js";
import { isIrNode, isIrSelect } from "../ir/types.js";
import type { Driver } from "../driver/types.js";
import type { RelationsMap, RelationDef } from "../entity/relations.js";
import type { AnyEntityClass, EntityInstance, SelectRow } from "../entity/entity.js";
import { parseArrowToIr, parseArrowToIrSelect } from "../parser/parse-arrow.js";
import { getDialect } from "../dbs/index.js";
import { resolveParamSentinels } from "../dbs/types.js";
import type { DialectImpl } from "../dbs/types.js";
import { buildRelationContext } from "./relation-context-builder.js";
import { resolveRelations } from "./relation-resolver.js";
import { whereColumnEq } from "./query-helpers.js";
import {
  buildRelationJoins,
  buildRelationPathToAlias,
  buildOneToManyExists,
  type RelationJoinInfo,
} from "./relation-joins.js";

const DEFAULT_ROW_PARAM = "u";
const TABLE_ALIAS = "t0";

export interface QueryBuilderInterface<C extends AnyEntityClass, T> {
  where(ir: IrNode, params?: Record<string, unknown>): QueryBuilderInterface<C, T>;
  select<U>(fn: (row: SelectRow<C>) => U): QueryBuilderInterface<C, U>;
  select(cols: string[] | IrSelect): QueryBuilderInterface<C, T>;
  orderBy(col: string, dir?: string): QueryBuilderInterface<C, T>;
  limit(n: number): QueryBuilderInterface<C, T>;
  offset(n: number): QueryBuilderInterface<C, T>;
  toArray(): Promise<T[]>;
}


/** Derive the row parameter name used in IR expressions (e.g. "u", "c")
 *  from whichever of selectIr, whereIr, or orderBy is available. */
function getRootParam(state: QueryState<unknown>): string {
  if (state.selectIr?.param) return state.selectIr.param;
  if (state.whereIr) {
    const names = new Set<string>();
    collectParamNamesFromNode(state.whereIr, names);
    const first = names.values().next().value;
    if (first) return first;
  }
  return state.orderBy[0]?.param ?? DEFAULT_ROW_PARAM;
}

/** Return JOIN descriptors for any to-one/one-to-one relations referenced in
 *  the WHERE clause, or an empty array when there are no relations. */
function getRelationJoins(state: QueryState<unknown>): RelationJoinInfo[] {
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
    rootParam
  );
}

/** Compile all WHERE-referenced relation joins to a SQL JOIN fragment. */
function buildJoinsSql(state: QueryState<unknown>, dialect: DialectImpl): string {
  return getRelationJoins(state).map((j) => dialect.buildJoinClause(j)).join("");
}

/** Assemble the compile options passed to every dialect compiler call:
 *  table alias mapping, JOIN alias lookup, and EXISTS subquery info. */
function getCompileOpts(state: QueryState<unknown>) {
  const paramToAlias = buildParamToAlias(state);
  const joins = getRelationJoins(state);
  const rootParam = getRootParam(state);
  const relationPathToAlias = buildRelationPathToAlias(joins, rootParam);
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

/** Resolve the dialect implementation for the current driver, defaulting to SQLite. */
function getDialectOrThrow(state: QueryState<unknown>) {
  return getDialect(state.driver.dialect ?? "sqlite");
}

/** Produce the IrSelect handed to the SQL compiler.
 *  When columnPaths is non-null the relation paths have been resolved, so
 *  substitute them; otherwise pass the original selectIr through unchanged. */
function buildSelectForSql(
  selectIr: IrSelect | null,
  columnPaths: string[][] | null,
  columnAliases: string[] | null
): IrSelect | null {
  if (columnPaths === null) return selectIr;
  return (columnPaths.length > 0 || selectIr?.rest)
    ? { param: selectIr!.param, paths: columnPaths, aliases: columnAliases!, ...(selectIr!.rest ? { rest: true } : {}) }
    : selectIr;
}

/** Recursively gather every row-parameter name referenced inside an IR node tree
 *  (e.g. "u" from `u.name === "Alice"`). */
function collectParamNamesFromNode(node: IrNode, out: Set<string>): void {
  switch (node.kind) {
    case "member":
      out.add(node.param);
      break;
    case "binary":
      collectParamNamesFromNode(node.left, out);
      collectParamNamesFromNode(node.right, out);
      break;
    case "unary":
      collectParamNamesFromNode(node.operand, out);
      break;
    case "in":
      collectParamNamesFromNode(node.left, out);
      collectParamNamesFromNode(node.right, out);
      break;
    case "call":
      collectParamNamesFromNode(node.receiver, out);
      for (const a of node.args) collectParamNamesFromNode(a, out);
      break;
    case "exists":
      out.add(node.rootParam);
      break;
    default:
      break;
  }
}

/** Map every row-parameter name in the query to the main table alias (t0),
 *  so the dialect compiler can qualify column references correctly. */
function buildParamToAlias(state: QueryState<unknown>): Record<string, string> {
  const names = new Set<string>();
  names.add(DEFAULT_ROW_PARAM);
  if (state.whereIr) collectParamNamesFromNode(state.whereIr, names);
  for (const o of state.orderBy) names.add(o.param);
  if (state.selectIr) names.add(state.selectIr.param);
  const paramToAlias: Record<string, string> = {};
  for (const p of names) paramToAlias[p] = TABLE_ALIAS;
  return paramToAlias;
}

export interface QueryState<T = unknown> {
  tableName: string;
  columnNames: string[];
  driver: Driver;
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
    }) as QueryBuilder<C, T>;
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

    if (isIrNode(predicate)) {
      this.state.whereIr = predicate;
    } else {
      try {
        this.state.whereIr = parseArrowToIr(predicate as (u: any) => boolean, {
          paramKeys: params ? Object.keys(params) : [],
        });
      } catch (e) {
        throw new Error("Failed to parse arrow predicate: " + (e instanceof Error ? e.message : String(e)));
      }
    }
    return this;
  }

  /** Append an ORDER BY clause for the given column. Defaults to ascending order. */
  orderBy(column: string, direction: "asc" | "desc" = "asc"): QueryBuilder<C, T> {
    this.state.orderBy.push({ param: DEFAULT_ROW_PARAM, path: [column], direction });
    return this;
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
    if (typeof columnsOrIr === "function") {
      const parsed = parseArrowToIrSelect(columnsOrIr);
      if (!parsed) {
        throw new Error(
          "select(): could not parse lambda at runtime. Use the Typhex transformer for complex selects, or pass column names / IrSelect."
        );
      }
      this.state.selectIr = parsed;
      return this as unknown as QueryBuilder<C, unknown>;
    }
    this.state.selectIr = isIrSelect(columnsOrIr)
      ? columnsOrIr
      : { param: "u", paths: columnsOrIr.map((c) => [c]) };
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
    }) as QueryBuilder<C, T>;
    return (await fresh.first()) ?? null;
  }

  /**
   * Insert row and return the hydrated instance.
   * If dialect sets returningRow on compile result, use driver.query() and the returned row; else run then fetch by pk.
   */
  async insert(row: Record<string, unknown>): Promise<EntityInstance<C>> {
    const { tableName, columnNames, driver, pkColumn, hydrate } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const cols = columnNames.filter((c) => row[c] !== undefined);
    const params = cols.map((c) => row[c]);
    const pk = pkColumn ?? "id";

    const compiled = dialect.compileInsert(tableName, cols, params, pk);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(compiled.sql, compiled.params);

    if (compiled.returningRow) {
      const rows = (await driver.query(compiled.sql, compiled.params)) as Record<string, unknown>[];
      const raw = rows[0];
      if (raw == null) throw new Error("insert: RETURNING returned no row");
      if (hydrate) return (await hydrate(raw)) as EntityInstance<C>;
      return raw as EntityInstance<C>;
    }

    const result = await driver.run(compiled.sql, compiled.params);
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
    const { hydrate, driver } = this.state;
    const ctx = buildRelationContext(
      this.state.selectIr, this.state.relations, this.state.whereIr,
      this.state.pkColumn, getRootParam(this.state)
    );
    const rows = await this.executeMainQuery(buildSelectForSql(this.state.selectIr, ctx.columnPaths, ctx.columnAliases));
    await resolveRelations(ctx, this.state.selectIr, driver, rows);
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
    const { tableName, driver } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const joinsSql = buildJoinsSql(this.state, dialect);
    const { sql, params: runParams } = dialect.compileCount(tableName, whereSql, params, joinsSql || undefined);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, runParams);
    const rows = (await driver.query(sql, runParams)) as [{ c: number }];
    return rows[0]?.c ?? 0;
  }

  /** Execute an UPDATE for the current WHERE clause and return the number of affected rows. */
  async update(set: Record<string, unknown>): Promise<number> {
    const { tableName, columnNames, driver } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params: whereParams } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const { sql, params } = dialect.compileUpdate(tableName, set, columnNames, whereSql, whereParams);
    if (!sql) return 0;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const result = await driver.run(sql, params);
    return result.changes;
  }

  /** Execute a DELETE for the current WHERE clause and return the number of affected rows. */
  async delete(): Promise<number> {
    const { tableName, driver } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const { sql, params: runParams } = dialect.compileDelete(tableName, whereSql, params);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, runParams);
    const result = await driver.run(sql, runParams);
    return result.changes;
  }

  /** Compile and run the main SELECT query, incorporating WHERE, JOINs, ORDER BY,
   *  LIMIT, OFFSET, and the resolved SELECT list. */
  private async executeMainQuery(selectForSql: IrSelect | null): Promise<Record<string, unknown>[]> {
    const { tableName, columnNames, driver } = this.state;
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
    return driver.query(sql, params) as Promise<Record<string, unknown>[]>;
  }
}
