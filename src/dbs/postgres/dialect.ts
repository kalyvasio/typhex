/**
 * PostgreSQL dialect: compilation and schema translation.
 */

import { JOIN_SQL_KEYWORDS } from "../../ir/types.js";
import type { IrNode, IrOrderBy, IrSelect, IrAggregate } from "../../ir/types.js";
import type { CompileOptions, CompileResult, ColumnDef, DialectImpl, CompileSelectOpts, ResolvedOpts } from "../types.js";
import type { RelationJoinInfo } from "../../orm/relation-joins.js";
import { getColumnDef, SQL_DEFAULT } from "../types.js";
import {
  quoteId,
  resolveOpts,
  makeCompileNode,
  compileOrderBy,
  compileSelectList,
  compileAggregate,
  compileConcatAggregate,
  compileStandardAggregate,
  compileGroupBy,
} from "../shared-dialect.js";

function postgresCompileAggregate(
  agg: IrAggregate,
  opts?: ResolvedOpts,
  compileNodeFn?: (node: IrNode, opts: ResolvedOpts, params: unknown[]) => string,
  params?: unknown[]
): string {
  // Map GROUP_CONCAT → STRING_AGG (cross-dialect compatibility)
  if (agg.func === "GROUP_CONCAT" || agg.func === "STRING_AGG") {
    return compileConcatAggregate("STRING_AGG", agg, "','", opts, compileNodeFn, params);
  }
  if (agg.func === "ARRAY_AGG" || agg.func === "JSON_AGG") {
    return compileStandardAggregate(agg.func, agg, opts, compileNodeFn, params);
  }
  return compileAggregate(agg, opts, compileNodeFn, params);
}

export const postgresDialect: DialectImpl = {
  name: "postgres",

  escapeIdentifier(name: string): string {
    return '"' + String(name).replace(/"/g, '""') + '"';
  },

  placeholder(index: number): string {
    return `$${index}`;
  },

  expandPlaceholders(sql: string, resolvedParams: unknown[], startIdx = 1): { sql: string; params: unknown[] } {
    let idx = 0;
    const newParams: unknown[] = [];
    let paramIndex = startIdx;
    const newSql = sql.replace(/\$(\d+)/g, () => {
      const v = resolvedParams[idx++];
      if (Array.isArray(v)) {
        v.forEach((x) => newParams.push(x));
        return v.map(() => `$${paramIndex++}`).join(", ");
      }
      newParams.push(v);
      return `$${paramIndex++}`;
    });
    return { sql: newSql, params: newParams };
  },

  compileWhere(node: IrNode | null, options: CompileOptions = {}): CompileResult {
    const opts = resolveOpts(options);
    const params: unknown[] = [];
    const sql = node ? compileNode(node, opts, params) : "1=1";
    return { sql, params };
  },

  compileOrderBy(orders: IrOrderBy[], options: CompileOptions = {}): string {
    return compileOrderBy(orders, options);
  },

  compileSelectList(select: IrSelect | null, columns: string[], options: CompileOptions = {}): string {
    return compileSelectList(select, columns, options, postgresCompileAggregate);
  },

  toColumnDef(def: ColumnDef): string {
    return getColumnDef(def, "postgres");
  },

  compileInsertMany(
    table: string,
    columns: string[],
    rows: unknown[][],
    pk?: string
  ): CompileResult {
    const esc = quoteId;
    if (rows.length === 0) return { sql: "", params: [], returningRow: false };
    let paramIdx = 1;
    const params: unknown[] = [];
    const rowPlaceholders = rows.map(row => {
      const phs = row.map(v => {
        if (v === SQL_DEFAULT) return "DEFAULT";
        params.push(v);
        return `$${paramIdx++}`;
      });
      return `(${phs.join(", ")})`;
    });
    let sql = `INSERT INTO ${esc(table)} (${columns.map(esc).join(", ")}) VALUES ${rowPlaceholders.join(", ")}`;
    if (pk) sql += " RETURNING *";
    return { sql, params, returningRow: !!pk };
  },

  compileCount(table: string, whereSql: string, whereParams: unknown[], joinsSql?: string): CompileResult {
    return { sql: `SELECT COUNT(*) AS c FROM ${quoteId(table)} AS t0${joinsSql ?? ""} WHERE ${whereSql}`, params: whereParams };
  },

  compileUpdate(table: string, set: Record<string, unknown>, columns: string[], whereSql: string, whereParams: unknown[]): CompileResult {
    const cols = Object.keys(set).filter((k) => columns.includes(k));
    if (cols.length === 0) return { sql: "", params: [] };
    const esc = quoteId;
    const assignments = cols.map((c, i) => `${esc(c)} = $${i + 1}`).join(", ");
    const fixedWhere = whereSql.replace(/"t0"\./g, `${esc(table)}.`);
    const renumberedWhere = fixedWhere.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) + cols.length}`);
    return { sql: `UPDATE ${esc(table)} SET ${assignments} WHERE ${renumberedWhere}`, params: [...cols.map((c) => set[c]), ...whereParams] };
  },

  compileDelete(table: string, whereSql: string, whereParams: unknown[]): CompileResult {
    const esc = quoteId;
    const fixedWhere = whereSql.replace(/"t0"\./g, `${esc(table)}.`);
    return { sql: `DELETE FROM ${esc(table)} WHERE ${fixedWhere}`, params: whereParams };
  },

  compileSelect(opts: CompileSelectOpts): CompileResult {
    const esc = quoteId;
    const params = [...opts.whereParams];
    const groupByClause = opts.groupBy && opts.groupBy.length > 0
      ? ` GROUP BY ${compileGroupBy(opts.groupBy, resolveOpts(opts.compileOpts ?? {}))}`
      : "";
    let havingClause = "";
    if (opts.havingSql) {
      havingClause = ` HAVING ${opts.havingSql}`;
      params.push(...(opts.havingParams ?? []));
    }
    let paramIdx = params.length + 1;
    const ph = () => `$${paramIdx++}`;
    let limitClause = "";
    let offsetClause = "";
    if (opts.limitNum != null) { limitClause = ` LIMIT ${ph()}`; params.push(opts.limitNum); }
    if (opts.offsetNum != null) { offsetClause = ` OFFSET ${ph()}`; params.push(opts.offsetNum); }
    const orderClause = opts.orderBySql ? ` ORDER BY ${opts.orderBySql}` : "";
    const sql = `SELECT ${opts.selectList} FROM ${esc(opts.table)} AS t0${opts.joinsSql ?? ""} WHERE ${opts.whereSql}${groupByClause}${havingClause}${orderClause}${limitClause}${offsetClause}`;
    return { sql, params };
  },

  compileExists(targetTable: string, alias: string, fkColumn: string, mainAlias: string, mainPk: string, innerSql: string): string {
    return `(EXISTS (SELECT 1 FROM ${quoteId(targetTable)} AS ${quoteId(alias)} WHERE ${quoteId(alias)}.${quoteId(fkColumn)} = ${quoteId(mainAlias)}.${quoteId(mainPk)} AND (${innerSql})))`;
  },

  compileLike(receiver: string, arg: string, mode: "startsWith" | "endsWith" | "includes"): string {
    if (mode === "startsWith") return `(${receiver} LIKE ${arg} || '%')`;
    if (mode === "endsWith")   return `(${receiver} LIKE '%' || ${arg})`;
    return                            `(${receiver} LIKE '%' || ${arg} || '%')`;
  },

  compileAggregate: postgresCompileAggregate,

  buildJoinClause(join: RelationJoinInfo): string {
    // Postgres does not allow CROSS JOIN with an ON clause; map to INNER JOIN instead.
    const kw = join.joinType === "cross" ? "INNER JOIN" : (JOIN_SQL_KEYWORDS[join.joinType] ?? "LEFT JOIN");
    return ` ${kw} ${quoteId(join.targetTable)} AS ${quoteId(join.alias)} ON ${quoteId("t0")}.${quoteId(join.foreignKey)} = ${quoteId(join.alias)}.${quoteId(join.targetPk)}`;
  },
};

const compileNode = makeCompileNode(postgresDialect);
