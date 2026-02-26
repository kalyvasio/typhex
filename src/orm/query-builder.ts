/**
 * Query builder: the single place where all SQL is built and executed.
 * Provides both query (select, count) and mutation (insert, update, delete,
 * create, findById) methods. All methods that hit the database return Promises
 * (except insert, which is synchronous to support save()).
 */

import type { IrNode, IrOrderBy, IrSelect } from "../ir/types.js";
import { isIrNode, isIrSelect } from "../ir/types.js";
import { compileWhere, compileOrderBy, compileSelectList, expandInParams, escapeIdentifier } from "../compiler/sql.js";
import type { Driver } from "../driver/types.js";
import { parseArrowToIr, parseArrowToIrSelect } from "../parser/parse-arrow.js";

const DEFAULT_ROW_PARAM = "u";
const TABLE_ALIAS = "t0";

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
  hydrate?: (row: Record<string, unknown>) => T | Promise<T>;
}

export class QueryBuilder<T = unknown> {
  private static readonly isDebugSqlEnabled = ((): boolean => {
    const debugFlag = process?.env?.TYPHEX_DEBUG;
    return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes";
  })();

  constructor(private state: QueryState<T>) {}

  clone(): QueryBuilder<T> {
    return new QueryBuilder({
      ...this.state,
      whereParams: { ...this.state.whereParams },
      orderBy: [...this.state.orderBy],
    });
  }

  private logSql(sql: string, params: unknown[]): void {
    console.log("[typhex]", sql);
    if (params.length > 0) console.log("[typhex] params:", params);
  }

  where(
    predicate: IrNode | ((entity: T) => boolean),
    params?: Record<string, unknown>
  ): QueryBuilder<T> {
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

  orderBy(column: string, direction: "asc" | "desc" = "asc"): QueryBuilder<T> {
    this.state.orderBy.push({ param: DEFAULT_ROW_PARAM, path: [column], direction });
    return this;
  }

  limit(n: number): QueryBuilder<T> {
    this.state.limitNum = n;
    return this;
  }

  offset(n: number): QueryBuilder<T> {
    this.state.offsetNum = n;
    return this;
  }

  select(
    columnsOrIr: string[] | IrSelect | ((entity: T) => Record<string, unknown>)
  ): QueryBuilder<T> {
    if (typeof columnsOrIr === "function") {
      const parsed = parseArrowToIrSelect(columnsOrIr);
      if (!parsed) {
        throw new Error(
          "select(): could not parse lambda at runtime. Use the Typhex transformer for complex selects, or pass column names / IrSelect."
        );
      }
      this.state.selectIr = parsed;
      return this;
    }
    this.state.selectIr = isIrSelect(columnsOrIr)
      ? columnsOrIr
      : { param: "u", paths: columnsOrIr.map((c) => [c]) };
    return this;
  }

  async findById(id: number | string): Promise<T | null> {
    return this.fetchByPk(id);
  }

  async create(row: Record<string, unknown>): Promise<T> {
    const lastId = await this.insert(row);
    const inst = await this.fetchByPk(lastId);
    if (!inst) throw new Error("create: insert succeeded but row not found");
    return inst;
  }

  async updateByPk(id: unknown, set: Record<string, unknown>): Promise<number> {
    const { pkColumn, tableName, columnNames, driver } = this.state;
    if (!pkColumn) throw new Error("updateByPk requires pkColumn");
    const cols = Object.keys(set).filter((k) => columnNames.includes(k));
    if (cols.length === 0) return 0;
    const assignments = cols.map((c) => `${escapeIdentifier(c)} = ?`).join(", ");
    const values = cols.map((c) => set[c]);
    const sql = `UPDATE ${escapeIdentifier(tableName)} SET ${assignments} WHERE ${escapeIdentifier(pkColumn)} = ?`;
    const params = [...values, id];
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    return driver.run(sql, params).changes;
  }

  async deleteByPk(id: unknown): Promise<number> {
    const { pkColumn, tableName, driver } = this.state;
    if (!pkColumn) throw new Error("deleteByPk requires pkColumn");
    const sql = `DELETE FROM ${escapeIdentifier(tableName)} WHERE ${escapeIdentifier(pkColumn)} = ?`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, [id]);
    return driver.run(sql, [id]).changes;
  }

  async patch(set: Record<string, unknown>): Promise<T | null> {
    await this.update(set);
    const fresh = new QueryBuilder<T>({
      ...this.state,
      orderBy: [],
      limitNum: null,
      offsetNum: null,
      selectIr: null,
    });
    return (await fresh.first()) ?? null;
  }

  private async fetchByPk(id: unknown): Promise<T | null> {
    const { pkColumn, tableName, columnNames, driver, hydrate } = this.state;
    if (!pkColumn) throw new Error("fetchByPk requires pkColumn");
    const selectList = columnNames.map((c) => escapeIdentifier(c)).join(", ");
    const sql = `SELECT ${selectList} FROM ${escapeIdentifier(tableName)} WHERE ${escapeIdentifier(pkColumn)} = ? LIMIT 1`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, [id]);
    const rows = driver.query(sql, [id]) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return hydrate ? hydrate(rows[0]) : (rows[0] as T);
  }

  async insert(row: Record<string, unknown>): Promise<number> {
    const { tableName, columnNames, driver } = this.state;
    const cols = columnNames.filter((c) => row[c] !== undefined);
    const params = cols.map((c) => row[c]);
    const sql = cols.length === 0
      ? `INSERT INTO ${escapeIdentifier(tableName)} DEFAULT VALUES`
      : `INSERT INTO ${escapeIdentifier(tableName)} (${cols.map((c) => escapeIdentifier(c)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const result = driver.run(sql, params);
    return result.lastID ?? 0;
  }

  async toArray(): Promise<T[]> {
    const rows = this.executeSelect() as Record<string, unknown>[];
    const { hydrate } = this.state;
    if (!hydrate) return rows as T[];
    return Promise.all(rows.map((r) => hydrate(r)));
  }

  async first(): Promise<T | undefined> {
    const arr = await this.limit(1).toArray();
    return arr[0];
  }

  async count(): Promise<number> {
    const { tableName } = this.state;
    const opts = { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(this.state) };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params } = expandInParams(whereResult.sql, whereResult.params, this.state.whereParams);
    const sql = `SELECT COUNT(*) AS c FROM ${escapeIdentifier(tableName)} AS t0 WHERE ${whereSql}`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const rows = this.state.driver.query(sql, params) as [{ c: number }];
    return rows[0]?.c ?? 0;
  }

  async update(set: Record<string, unknown>): Promise<number> {
    const { tableName, columnNames } = this.state;
    const opts = { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(this.state) };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params: whereParams } = expandInParams(whereResult.sql, whereResult.params, this.state.whereParams);
    const cols = Object.keys(set).filter((k) => columnNames.includes(k));
    const assignments = cols.map((c) => `${escapeIdentifier(c)} = ?`).join(", ");
    const values = cols.map((c) => set[c]);
    const fixedWhere = whereSql.replace(/"t0"\./g, `${escapeIdentifier(tableName)}.`);
    const sql = `UPDATE ${escapeIdentifier(tableName)} SET ${assignments} WHERE ${fixedWhere}`;
    const updateParams = [...values, ...whereParams];
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, updateParams);
    return this.state.driver.run(sql, updateParams).changes;
  }

  async delete(): Promise<number> {
    const { tableName } = this.state;
    const opts = { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(this.state) };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params } = expandInParams(whereResult.sql, whereResult.params, this.state.whereParams);
    const fixedWhere = whereSql.replace(/"t0"\./g, `${escapeIdentifier(tableName)}.`);
    const sql = `DELETE FROM ${escapeIdentifier(tableName)} WHERE ${fixedWhere}`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    return this.state.driver.run(sql, params).changes;
  }

  private executeSelect(): unknown[] {
    const { tableName, columnNames } = this.state;
    const opts = { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(this.state) };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params: finalParams } = expandInParams(whereResult.sql, whereResult.params, this.state.whereParams);
    const selectList = compileSelectList(this.state.selectIr, columnNames, opts);
    const orderBySql = compileOrderBy(this.state.orderBy, opts);
    const orderClause = orderBySql ? ` ORDER BY ${orderBySql}` : "";
    let limitClause = "";
    let offsetClause = "";
    const params = [...finalParams];
    if (this.state.limitNum != null) {
      const n = Math.floor(Number(this.state.limitNum));
      if (n < 0 || !Number.isFinite(n)) throw new Error("limit must be a non-negative integer");
      limitClause = " LIMIT ?";
      params.push(n);
    }
    if (this.state.offsetNum != null) {
      const n = Math.floor(Number(this.state.offsetNum));
      if (n < 0 || !Number.isFinite(n)) throw new Error("offset must be a non-negative integer");
      offsetClause = " OFFSET ?";
      params.push(n);
    }
    const sql = `SELECT ${selectList} FROM ${escapeIdentifier(tableName)} AS t0 WHERE ${whereSql}${orderClause}${limitClause}${offsetClause}`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    return this.state.driver.query(sql, params);
  }
}
