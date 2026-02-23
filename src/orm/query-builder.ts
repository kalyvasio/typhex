/**
 * Query builder: where, select, orderBy, limit, offset, toArray, first, count.
 */

import type { IrNode, IrOrderBy, IrSelect } from "../ir/types.js";
import { isIrNode, isIrSelect } from "../ir/types.js";
import { compileWhere, compileOrderBy, compileSelectList, expandInParams } from "../compiler/sql.js";
import type { Table } from "./table.js";
import type { Driver } from "../driver/types.js";
import { parseArrowToIr } from "../parser/parse-arrow.js";

/** Default param name for builder-created IR (orderBy, select) when no arrow is involved. */
const DEFAULT_ROW_PARAM = "u";

const TABLE_ALIAS = "t0";

function collectParamNamesFromNode(node: IrNode, out: Set<string>): void {
  switch (node.kind) {
    case "member":
      out.add(node.param);
      break;
    case "binary":
    case "unary":
      if (node.kind === "binary") {
        collectParamNamesFromNode(node.left, out);
        collectParamNamesFromNode(node.right, out);
      } else {
        collectParamNamesFromNode(node.operand, out);
      }
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
  table: Table<T>;
  driver: Driver;
  whereIr: IrNode | null;
  whereParams: Record<string, unknown>;
  orderBy: IrOrderBy[];
  limitNum: number | null;
  offsetNum: number | null;
  selectIr: IrSelect | null;
}

export class QueryBuilder<T = unknown> {
  private static readonly isDebugSqlEnabled = ((): boolean => {
    const debugFlag = process?.env?.TYPHEX_DEBUG;
    return debugFlag === "1" || debugFlag === "true" || debugFlag === "yes";
  })();

  constructor(private state: QueryState<T>) {}

  /** Return a new QueryBuilder with a copy of the current state. Use this to branch and build different queries from the same base. */
  clone(): QueryBuilder<T> {
    return new QueryBuilder({
      table: this.state.table,
      driver: this.state.driver,
      whereIr: this.state.whereIr,
      whereParams: { ...this.state.whereParams },
      orderBy: [...this.state.orderBy],
      limitNum: this.state.limitNum,
      offsetNum: this.state.offsetNum,
      selectIr: this.state.selectIr,
    });
  }

  /** Log SQL query and params to the console on debug mode. */
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
      throw new Error(
        "select() with a lambda requires the Typhex transformer (e.g. ts-patch with typhex/transformer)"
      );
    }
    this.state.selectIr = isIrSelect(columnsOrIr)
      ? columnsOrIr
      : {
          param: "u",
          paths: columnsOrIr.map((c) => [c]),
        };
    return this;
  }

  toArray(): T[] {
    const table = this.state.table;
    const tableName = table.tableName;
    const columns = table.columnNames;
    const opts = { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(this.state) };

    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params: finalParams } = expandInParams(
      whereResult.sql,
      whereResult.params,
      this.state.whereParams
    );

    const selectList = compileSelectList(this.state.selectIr, columns, opts);
    const orderBySql = compileOrderBy(this.state.orderBy, opts);
    const orderClause = orderBySql ? ` ORDER BY ${orderBySql}` : "";
    const limitClause = this.state.limitNum != null ? ` LIMIT ${this.state.limitNum}` : "";
    const offsetClause = this.state.offsetNum != null ? ` OFFSET ${this.state.offsetNum}` : "";

    const sql = `SELECT ${selectList} FROM "${tableName}" AS t0 WHERE ${whereSql}${orderClause}${limitClause}${offsetClause}`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, finalParams);
    return this.state.driver.query(sql, finalParams) as T[];
  }

  first(): T | undefined {
    const arr = this.limit(1).toArray();
    return arr[0];
  }

  count(): number {
    const table = this.state.table;
    const opts = { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(this.state) };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params } = expandInParams(
      whereResult.sql,
      whereResult.params,
      this.state.whereParams
    );
    const sql = `SELECT COUNT(*) AS c FROM "${table.tableName}" AS t0 WHERE ${whereSql}`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const rows = this.state.driver.query(sql, params) as [{ c: number }];
    return rows[0]?.c ?? 0;
  }

  update(set: Record<string, unknown>): number {
    const table = this.state.table;
    const opts = { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(this.state) };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params: whereParams } = expandInParams(
      whereResult.sql,
      whereResult.params,
      this.state.whereParams
    );
    const cols = Object.keys(set).filter((k) => table.columnNames.includes(k));
    const assignments = cols.map((c) => `"${c}" = ?`).join(", ");
    const values = cols.map((c) => set[c]);
    const fixedWhere = whereSql.replace(/"t0"\./g, `"${table.tableName}".`);
    const sql = `UPDATE "${table.tableName}" SET ${assignments} WHERE ${fixedWhere}`;
    const updateParams = [...values, ...whereParams];
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, updateParams);
    const result = this.state.driver.run(sql, updateParams);
    return result.changes;
  }

  delete(): number {
    const table = this.state.table;
    const opts = { tableAlias: TABLE_ALIAS, paramToAlias: buildParamToAlias(this.state) };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params } = expandInParams(
      whereResult.sql,
      whereResult.params,
      this.state.whereParams
    );
    const fixedWhere = whereSql.replace(/"t0"\./g, `"${table.tableName}".`);
    const sql = `DELETE FROM "${table.tableName}" WHERE ${fixedWhere}`;
    if (QueryBuilder.isDebugSqlEnabled) this.logSql(sql, params);
    const result = this.state.driver.run(sql, params);
    return result.changes;
  }
}
