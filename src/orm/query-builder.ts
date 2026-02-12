/**
 * Query builder: where, select, orderBy, limit, offset, toArray, first, count.
 */

import type { IrNode, IrOrderBy, IrSelect } from "../ir/types.js";
import { isIrNode } from "../ir/types.js";
import { compileWhere, compileOrderBy, compileSelectList, expandInParams } from "../compiler/sql.js";
import type { Table } from "./table.js";
import type { Driver } from "../driver/types.js";
import { parseArrowToIr } from "../parser/parse-arrow.js";

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
  constructor(private state: QueryState<T>) {}

  where(
    predicate: IrNode | ((entity: T) => boolean),
    params?: Record<string, unknown>
  ): QueryBuilder<T> {
    let whereIr: IrNode | null = null;
    let whereParams = { ...this.state.whereParams };
    if (params) Object.assign(whereParams, params);

    if (isIrNode(predicate)) {
      whereIr = predicate;
    } else {
      try {
        whereIr = parseArrowToIr(predicate as (u: unknown) => boolean, {
          paramName: "u",
          paramKeys: params ? Object.keys(params) : [],
        });
      } catch (e) {
        throw new Error("Failed to parse arrow predicate: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    return new QueryBuilder({
      ...this.state,
      whereIr,
      whereParams,
    });
  }

  orderBy(column: string, direction: "asc" | "desc" = "asc"): QueryBuilder<T> {
    return new QueryBuilder({
      ...this.state,
      orderBy: [
        ...this.state.orderBy,
        { param: "u", path: [column], direction },
      ],
    });
  }

  limit(n: number): QueryBuilder<T> {
    return new QueryBuilder({ ...this.state, limitNum: n });
  }

  offset(n: number): QueryBuilder<T> {
    return new QueryBuilder({ ...this.state, offsetNum: n });
  }

  select(columns: string[]): QueryBuilder<T> {
    return new QueryBuilder({
      ...this.state,
      selectIr: {
        param: "u",
        paths: columns.map((c) => [c]),
      },
    });
  }

  toArray(): T[] {
    const table = this.state.table;
    const tableName = table.tableName;
    const columns = table.columnNames;
    const opts = { tableAlias: "t0", paramToAlias: { u: "t0" } };

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
    const rows = this.state.driver.query(sql, finalParams) as T[];
    return rows;
  }

  first(): T | undefined {
    const arr = this.limit(1).toArray();
    return arr[0];
  }

  count(): number {
    const table = this.state.table;
    const opts = { tableAlias: "t0", paramToAlias: { u: "t0" } };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params } = expandInParams(
      whereResult.sql,
      whereResult.params,
      this.state.whereParams
    );
    const sql = `SELECT COUNT(*) AS c FROM "${table.tableName}" AS t0 WHERE ${whereSql}`;
    const rows = this.state.driver.query(sql, params) as [{ c: number }];
    return rows[0]?.c ?? 0;
  }

  update(set: Record<string, unknown>): number {
    const table = this.state.table;
    const opts = { tableAlias: "t0", paramToAlias: { u: "t0" } };
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
    const result = this.state.driver.run(sql, [...values, ...whereParams]);
    return result.changes;
  }

  delete(): number {
    const table = this.state.table;
    const opts = { tableAlias: "t0", paramToAlias: { u: "t0" } };
    const whereResult = compileWhere(this.state.whereIr, opts);
    const { sql: whereSql, params } = expandInParams(
      whereResult.sql,
      whereResult.params,
      this.state.whereParams
    );
    const fixedWhere = whereSql.replace(/"t0"\./g, `"${table.tableName}".`);
    const sql = `DELETE FROM "${table.tableName}" WHERE ${fixedWhere}`;
    const result = this.state.driver.run(sql, params);
    return result.changes;
  }
}
