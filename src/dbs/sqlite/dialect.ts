/**
 * SQLite dialect: compilation and schema translation.
 */

import type {
  CompileResult,
  ColumnDef,
  DialectImpl,
  CompileSelectOpts,
  OnConflictClause,
} from "../types.js";
import type { RelationJoinInfo } from "../../orm/helpers/relations/relation-joins.js";
import type { Expr, ExprAggregate } from "../../orm/expr.js";
import { getColumnDef, SQL_DEFAULT } from "../types.js";
import {
  JOIN_SQL_KEYWORDS,
  quoteId,
  compilePlan as compilePlanShared,
  compileAggregate,
  compileConcatAggregate,
  compileGroupBy,
} from "../shared-dialect.js";

function sqliteCompileAggregate(
  agg: ExprAggregate,
  compileNodeFn?: (node: Expr, params: unknown[]) => string,
  params?: unknown[],
): string {
  if (agg.func === "GROUP_CONCAT") {
    return compileConcatAggregate("GROUP_CONCAT", agg, undefined, compileNodeFn, params);
  }
  return compileAggregate(agg, compileNodeFn, params);
}

function appendOnConflict(
  baseSql: string,
  onConflict: OnConflictClause,
  insertColumns: string[],
  esc: (name: string) => string,
): string {
  const conflictCols = onConflict.conflictColumns.map(esc).join(", ");
  if (onConflict.action === "nothing") {
    return `${baseSql} ON CONFLICT (${conflictCols}) DO NOTHING`;
  }
  const updateCols = onConflict.updateColumns?.length
    ? onConflict.updateColumns
    : insertColumns.filter((c) => !onConflict.conflictColumns.includes(c));
  const setClauses = updateCols.map((c) => `${esc(c)} = excluded.${esc(c)}`).join(", ");
  return `${baseSql} ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClauses}`;
}

export const sqliteDialect: DialectImpl = {
  name: "sqlite",
  insertCapabilities: {
    supportsReturning: true,
    supportsSequences: false,
  },
  compileNextSequenceValues(): CompileResult {
    throw new Error("SQLite does not support sequence allocation");
  },

  escapeIdentifier(name: string): string {
    return '"' + String(name).replaceAll('"', '""') + '"';
  },

  placeholder(_index: number): string {
    return "?";
  },

  expandPlaceholders(
    sql: string,
    resolvedParams: unknown[],
    _startIdx?: number,
  ): { sql: string; params: unknown[] } {
    let idx = 0;
    const newParams: unknown[] = [];
    const newSql = sql.replaceAll("?", () => {
      const v = resolvedParams[idx++];
      if (Array.isArray(v)) {
        v.forEach((x) => newParams.push(x));
        return v.map(() => "?").join(", ");
      }
      newParams.push(v);
      return "?";
    });
    return { sql: newSql, params: newParams };
  },

  compilePlan(plan, opts = {}) {
    return compilePlanShared(plan, opts, sqliteDialect);
  },

  toColumnDef(def: ColumnDef): string {
    return getColumnDef(def, "sqlite");
  },

  compileInsert(
    table: string,
    columns: string[],
    values: unknown[],
    _pk?: string[],
    onConflict?: OnConflictClause,
  ): CompileResult {
    const esc = quoteId;
    if (columns.length === 0) {
      if (onConflict) {
        throw new Error(
          "insert: ON CONFLICT requires explicit columns (empty INSERT not supported with onConflict)",
        );
      }
      return { sql: `INSERT INTO ${esc(table)} DEFAULT VALUES`, params: [] };
    }
    const ph = columns.map(() => "?").join(", ");
    let sql = `INSERT INTO ${esc(table)} (${columns.map(esc).join(", ")}) VALUES (${ph})`;
    if (onConflict) sql = appendOnConflict(sql, onConflict, columns, esc);
    return { sql, params: values, returningRow: false };
  },

  compileInsertMany(
    table: string,
    columns: string[],
    rows: unknown[][],
    pk?: string[],
    onConflict?: OnConflictClause,
  ): CompileResult {
    const esc = quoteId;
    if (rows.length === 0) return { sql: "", params: [], returningRow: false };
    const rowPh = `(${columns.map(() => "?").join(", ")})`;
    const allPh = rows.map(() => rowPh).join(", ");
    let sql = `INSERT INTO ${esc(table)} (${columns.map(esc).join(", ")}) VALUES ${allPh}`;
    if (onConflict) sql = appendOnConflict(sql, onConflict, columns, esc);
    const hasPk = !!pk?.length;
    if (hasPk) sql += " RETURNING *";
    return {
      sql,
      params: rows.flat().map((v) => (v === SQL_DEFAULT ? null : v)),
      returningRow: hasPk,
    };
  },

  compileCount(
    table: string,
    tableAlias: string,
    whereSql: string,
    whereParams: unknown[],
    joinsSql?: string,
  ): CompileResult {
    return {
      sql: `SELECT COUNT(*) AS c FROM ${quoteId(table)} AS ${quoteId(tableAlias)}${joinsSql ?? ""} WHERE ${whereSql}`,
      params: whereParams,
    };
  },

  compileUpdate(
    table: string,
    set: Record<string, unknown>,
    columns: string[],
    whereSql: string,
    whereParams: unknown[],
    options?: { returning?: boolean },
  ): CompileResult {
    const cols = Object.keys(set).filter((k) => columns.includes(k));
    if (cols.length === 0) return { sql: "", params: [] };
    const esc = quoteId;
    const assignments = cols.map((c) => `${esc(c)} = ?`).join(", ");
    const fixedWhere = whereSql.replaceAll('"t0".', `${esc(table)}.`);
    let sql = `UPDATE ${esc(table)} SET ${assignments} WHERE ${fixedWhere}`;
    if (options?.returning) sql += " RETURNING *";
    return {
      sql,
      params: [...cols.map((c) => set[c]), ...whereParams],
      returningRow: !!options?.returning,
    };
  },

  compileDelete(
    table: string,
    whereSql: string,
    whereParams: unknown[],
    options?: { returning?: boolean },
  ): CompileResult {
    const esc = quoteId;
    const fixedWhere = whereSql.replaceAll('"t0".', `${esc(table)}.`);
    let sql = `DELETE FROM ${esc(table)} WHERE ${fixedWhere}`;
    if (options?.returning) sql += " RETURNING *";
    return { sql, params: whereParams, returningRow: !!options?.returning };
  },

  compileSelect(opts: CompileSelectOpts): CompileResult {
    const esc = quoteId;
    const params = [...(opts.selectListParams ?? []), ...opts.whereParams];
    const groupByClause =
      opts.groupBy && opts.groupBy.length > 0 ? ` GROUP BY ${compileGroupBy(opts.groupBy)}` : "";
    let havingClause = "";
    if (opts.havingSql) {
      havingClause = ` HAVING ${opts.havingSql}`;
      params.push(...(opts.havingParams ?? []));
    }
    if (opts.orderByParams && opts.orderByParams.length > 0) {
      params.push(...opts.orderByParams);
    }
    let limitClause = "";
    let offsetClause = "";
    if (opts.limitNum != null) {
      limitClause = " LIMIT ?";
      params.push(opts.limitNum);
    }
    if (opts.offsetNum != null) {
      offsetClause = " OFFSET ?";
      params.push(opts.offsetNum);
    }
    const orderClause = opts.orderBySql ? ` ORDER BY ${opts.orderBySql}` : "";
    return {
      sql: `SELECT ${opts.selectList} FROM ${esc(opts.table)} AS ${esc(opts.tableAlias)}${opts.joinsSql ?? ""} WHERE ${opts.whereSql}${groupByClause}${havingClause}${orderClause}${limitClause}${offsetClause}`,
      params,
    };
  },

  compileExists(
    targetTable: string,
    alias: string,
    fkColumns: string[],
    mainAlias: string,
    mainPk: string[],
    innerSql: string,
  ): string {
    const pkConds = fkColumns
      .map(
        (fk, i) =>
          `${quoteId(alias)}.${quoteId(fk)} = ${quoteId(mainAlias)}.${quoteId(mainPk[i] ?? mainPk[0])}`,
      )
      .join(" AND ");
    return `(EXISTS (SELECT 1 FROM ${quoteId(targetTable)} AS ${quoteId(alias)} WHERE ${pkConds} AND (${innerSql})))`;
  },

  compileLike(receiver: string, arg: string, mode: "startsWith" | "endsWith" | "includes"): string {
    if (mode === "startsWith") return `(${receiver} LIKE ${arg} || '%')`;
    if (mode === "endsWith") return `(${receiver} LIKE '%' || ${arg})`;
    return `(${receiver} LIKE '%' || ${arg} || '%')`;
  },
  compileAggregate: sqliteCompileAggregate,

  buildJoinClause(join: RelationJoinInfo, mainAlias: string): string {
    const kw = JOIN_SQL_KEYWORDS[join.joinType] ?? "LEFT JOIN";
    const on = join.foreignKeys
      .map(
        (fk, i) =>
          `${quoteId(mainAlias)}.${quoteId(fk)} = ${quoteId(join.alias)}.${quoteId(join.targetPkColumns[i] ?? join.targetPkColumns[0])}`,
      )
      .join(" AND ");
    return ` ${kw} ${quoteId(join.targetTable)} AS ${quoteId(join.alias)} ON ${on}`;
  },
};
