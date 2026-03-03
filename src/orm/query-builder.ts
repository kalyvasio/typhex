/**
 * Query builder: the single place where all SQL is built and executed.
 * Provides both query (select, count) and mutation (insert, update, delete)
 * methods. All methods that hit the database return Promises
 * (except insert, which is synchronous to support save()).
 */

import type { IrNode, IrOrderBy, IrSelect } from "../ir/types.js";
import { isIrNode, isIrSelect } from "../ir/types.js";
import type { Driver } from "../driver/types.js";
import type { RelationsMap } from "../entity/relations.js";
import type { AnyEntityClass, EntityInstance, SelectRow } from "../entity/entity.js";
import { parseArrowToIr, parseArrowToIrSelect } from "../parser/parse-arrow.js";
import { getDialect } from "../dbs/index.js";
import { resolveParamSentinels } from "../dbs/types.js";
import { resolveSelectColumnsAndRelations, loadRelations } from "./relation-loader.js";
import { whereColumnEq } from "./query-helpers.js";

const DEFAULT_ROW_PARAM = "u";
const TABLE_ALIAS = "t0";

function getCompileOpts(state: QueryState<unknown>) {
  return { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(state) };
}

function getDialectOrThrow(state: QueryState<unknown>) {
  return getDialect(state.driver.dialect ?? "sqlite");
}

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
    default:
      break;
  }
}

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
}

/** C = entity class (for EntityInstance<C> return types); T = current row/selected shape. */
export class QueryBuilder<C extends AnyEntityClass = AnyEntityClass, T = EntityInstance<C>> {
  private static readonly isDebugSqlEnabled = ((): boolean => {
    const debugFlag = process?.env?.TYPHEX_DEBUG;
    return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes";
  })();

  constructor(private state: QueryState<T>) {}

  clone(): QueryBuilder<C, T> {
    return new QueryBuilder({
      ...this.state,
      whereParams: { ...this.state.whereParams },
      orderBy: [...this.state.orderBy],
    }) as QueryBuilder<C, T>;
  }

  private logSql(sql: string, params: unknown[]): void {
    console.log("[typhex]", sql);
    if (params.length > 0) console.log("[typhex] params:", params);
  }

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

  orderBy(column: string, direction: "asc" | "desc" = "asc"): QueryBuilder<C, T> {
    this.state.orderBy.push({ param: DEFAULT_ROW_PARAM, path: [column], direction });
    return this;
  }

  limit(n: number): QueryBuilder<C, T> {
    this.state.limitNum = n;
    return this;
  }

  offset(n: number): QueryBuilder<C, T> {
    this.state.offsetNum = n;
    return this;
  }

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
  async findByPk(id: number): Promise<EntityInstance<C> | null> {
    const pkColumn = this.state.pkColumn ?? "id";
    const row = await this.where(whereColumnEq(pkColumn, id)).first();
    return row ?? null;
  }

  async toArray(): Promise<EntityInstance<C>[]> {
    let rows = (await this.executeSelect()) as Record<string, unknown>[];
    const { hydrate, relations, selectIr } = this.state;
    if (relations && selectIr && (selectIr.relations?.length || selectIr.paths.some((p) => p.length >= 1 && relations[p[0]]))) {
      const { columnPaths, columnAliases, relationSpecs } = resolveSelectColumnsAndRelations(selectIr, this.state.columnNames, relations, this.state.pkColumn);
      if (relationSpecs.length > 0) {
        await loadRelations(rows, relationSpecs, this.state.driver);
      }
    }
    if (!hydrate) return rows as EntityInstance<C>[];
    return Promise.all(rows.map((r) => hydrate(r))) as Promise<EntityInstance<C>[]>;
  }

  async first(): Promise<EntityInstance<C> | undefined> {
    const arr = await this.limit(1).toArray();
    return arr[0];
  }

  async count(): Promise<number> {
    const { tableName, driver } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params } = dialect.expandPlaceholders(whereResult.sql, resolved);
    const { sql, params: runParams } = dialect.compileCount(tableName, whereSql, params);
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, runParams);
    const rows = (await driver.query(sql, runParams)) as [{ c: number }];
    return rows[0]?.c ?? 0;
  }

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

  private async executeSelect(): Promise<unknown[]> {
    const { tableName, columnNames, driver, selectIr, relations } = this.state;
    const dialect = getDialectOrThrow(this.state);
    const opts = getCompileOpts(this.state);
    const whereResult = dialect.compileWhere(this.state.whereIr, opts);
    const resolved = resolveParamSentinels(whereResult.params, this.state.whereParams);
    const { sql: whereSql, params: whereParams } = dialect.expandPlaceholders(whereResult.sql, resolved);

    let selectForSql = selectIr;
    if (relations && selectIr && (selectIr.relations?.length || selectIr.paths.some((p) => p.length >= 1 && relations[p[0]]))) {
      const { columnPaths, columnAliases } = resolveSelectColumnsAndRelations(selectIr, columnNames, relations, this.state.pkColumn);
      selectForSql = columnPaths.length > 0 ? { param: selectIr.param, paths: columnPaths, aliases: columnAliases } : selectIr;
    }
    const selectList = dialect.compileSelectList(selectForSql, columnNames, opts);
    const orderBySql = dialect.compileOrderBy(this.state.orderBy, opts);
    let limitNum: number | null = null;
    let offsetNum: number | null = null;
    if (this.state.limitNum != null) {
      const n = Math.floor(Number(this.state.limitNum));
      if (n < 0 || !Number.isFinite(n)) throw new Error("limit must be a non-negative integer");
      limitNum = n;
    }
    if (this.state.offsetNum != null) {
      const n = Math.floor(Number(this.state.offsetNum));
      if (n < 0 || !Number.isFinite(n)) throw new Error("offset must be a non-negative integer");
      offsetNum = n;
    }
    const { sql, params } = dialect.compileSelect({
      table: tableName,
      selectList,
      whereSql,
      whereParams,
      orderBySql,
      limitNum,
      offsetNum,
    });
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    return driver.query(sql, params);
  }
}
