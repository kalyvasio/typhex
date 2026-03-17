/**
 * SQLite dialect: compilation and schema translation.
 */

import { JOIN_SQL_KEYWORDS } from "../../ir/types.js";
import type { IrNode, IrOrderBy, IrSelect } from "../../ir/types.js";
import type { CompileOptions, CompileResult, ColumnDef, DialectImpl, CompileSelectOpts } from "../types.js";
import type { RelationJoinInfo } from "../../orm/relation-joins.js";
import { getColumnDef } from "../types.js";
import {
  quoteId,
  resolveOpts,
  makeCompileNode,
  compileOrderBy,
  compileSelectList,
  type DialectRenderer,
} from "../shared-dialect.js";

const renderer: DialectRenderer = {
  placeholder: () => "?",

  compileExists: (targetTable, alias, fkColumn, mainAlias, mainPk, innerSql) =>
    `(EXISTS (SELECT 1 FROM ${quoteId(targetTable)} AS ${quoteId(alias)} WHERE ${quoteId(alias)}.${quoteId(fkColumn)} = ${quoteId(mainAlias)}.${quoteId(mainPk)} AND (${innerSql})))`,

  compileLike: (receiver, arg, mode) => {
    if (mode === "startsWith") return `(${receiver} LIKE ${arg} || '%')`;
    if (mode === "endsWith")   return `(${receiver} LIKE '%' || ${arg})`;
    return                            `(${receiver} LIKE '%' || ${arg} || '%')`;
  },
};

const compileNode = makeCompileNode(renderer);

export const sqliteDialect: DialectImpl = {
  name: "sqlite",

  escapeIdentifier(name: string): string {
    return '"' + String(name).replace(/"/g, '""') + '"';
  },

  placeholder(_index: number): string {
    return "?";
  },

  expandPlaceholders(sql: string, resolvedParams: unknown[]): { sql: string; params: unknown[] } {
    let idx = 0;
    const newParams: unknown[] = [];
    const newSql = sql.replace(/\?/g, () => {
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
    return compileSelectList(select, columns, options);
  },

  toColumnDef(def: ColumnDef): string {
    return getColumnDef(def, "sqlite");
  },

  compileInsert(table: string, columns: string[], values: unknown[], _pk?: string): CompileResult {
    const esc = quoteId;
    if (columns.length === 0) return { sql: `INSERT INTO ${esc(table)} DEFAULT VALUES`, params: [] };
    const ph = columns.map(() => "?").join(", ");
    return { sql: `INSERT INTO ${esc(table)} (${columns.map(esc).join(", ")}) VALUES (${ph})`, params: values };
  },

  compileCount(table: string, whereSql: string, whereParams: unknown[], joinsSql?: string): CompileResult {
    return { sql: `SELECT COUNT(*) AS c FROM ${quoteId(table)} AS t0${joinsSql ?? ""} WHERE ${whereSql}`, params: whereParams };
  },

  compileUpdate(table: string, set: Record<string, unknown>, columns: string[], whereSql: string, whereParams: unknown[]): CompileResult {
    const cols = Object.keys(set).filter((k) => columns.includes(k));
    if (cols.length === 0) return { sql: "", params: [] };
    const esc = quoteId;
    const assignments = cols.map((c) => `${esc(c)} = ?`).join(", ");
    const fixedWhere = whereSql.replace(/"t0"\./g, `${esc(table)}.`);
    return { sql: `UPDATE ${esc(table)} SET ${assignments} WHERE ${fixedWhere}`, params: [...cols.map((c) => set[c]), ...whereParams] };
  },

  compileDelete(table: string, whereSql: string, whereParams: unknown[]): CompileResult {
    const esc = quoteId;
    const fixedWhere = whereSql.replace(/"t0"\./g, `${esc(table)}.`);
    return { sql: `DELETE FROM ${esc(table)} WHERE ${fixedWhere}`, params: whereParams };
  },

  compileSelect(opts: CompileSelectOpts): CompileResult {
    const esc = quoteId;
    const params = [...opts.whereParams];
    let limitClause = "";
    let offsetClause = "";
    if (opts.limitNum != null) { limitClause = " LIMIT ?"; params.push(opts.limitNum); }
    if (opts.offsetNum != null) { offsetClause = " OFFSET ?"; params.push(opts.offsetNum); }
    const orderClause = opts.orderBySql ? ` ORDER BY ${opts.orderBySql}` : "";
    return { sql: `SELECT ${opts.selectList} FROM ${esc(opts.table)} AS t0${opts.joinsSql ?? ""} WHERE ${opts.whereSql}${orderClause}${limitClause}${offsetClause}`, params };
  },

  buildJoinClause(join: RelationJoinInfo): string {
    const kw = JOIN_SQL_KEYWORDS[join.joinType] ?? "LEFT JOIN";
    return ` ${kw} ${quoteId(join.targetTable)} AS ${quoteId(join.alias)} ON ${quoteId("t0")}.${quoteId(join.foreignKey)} = ${quoteId(join.alias)}.${quoteId(join.targetPk)}`;
  },
};
