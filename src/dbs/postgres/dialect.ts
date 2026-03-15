/**
 * PostgreSQL dialect: compilation and schema translation.
 */

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
  placeholder: (params) => `$${params.length}`,

  compileExists: (targetTable, alias, fkColumn, mainAlias, mainPk, innerSql) =>
    `(EXISTS (SELECT 1 FROM ${quoteId(targetTable)} AS ${quoteId(alias)} WHERE ${quoteId(alias)}.${quoteId(fkColumn)} = ${quoteId(mainAlias)}.${quoteId(mainPk)} AND (${innerSql})))`,

  compileLike: (receiver, arg, mode) => {
    if (mode === "startsWith") return `(${receiver} LIKE ${arg} || '%')`;
    if (mode === "endsWith")   return `(${receiver} LIKE '%' || ${arg})`;
    return                            `(${receiver} LIKE '%' || ${arg} || '%')`;
  },
};

const compileNode = makeCompileNode(renderer);

export const postgresDialect: DialectImpl = {
  name: "postgres",

  escapeIdentifier(name: string): string {
    return '"' + String(name).replace(/"/g, '""') + '"';
  },

  placeholder(index: number): string {
    return `$${index}`;
  },

  expandPlaceholders(sql: string, resolvedParams: unknown[]): { sql: string; params: unknown[] } {
    let idx = 0;
    const newParams: unknown[] = [];
    let paramIndex = 1;
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
    return compileSelectList(select, columns, options);
  },

  toColumnDef(def: ColumnDef): string {
    return getColumnDef(def, "postgres");
  },

  compileInsert(table: string, columns: string[], values: unknown[], pk?: string): CompileResult {
    const esc = quoteId;
    if (columns.length === 0) {
      return { sql: `INSERT INTO ${esc(table)} DEFAULT VALUES${pk ? " RETURNING *" : ""}`, params: [], returningRow: !!pk };
    }
    const ph = columns.map((_, i) => `$${i + 1}`).join(", ");
    return { sql: `INSERT INTO ${esc(table)} (${columns.map(esc).join(", ")}) VALUES (${ph})${pk ? " RETURNING *" : ""}`, params: values, returningRow: !!pk };
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
    let paramIdx = params.length + 1;
    const ph = () => `$${paramIdx++}`;
    let limitClause = "";
    let offsetClause = "";
    if (opts.limitNum != null) { limitClause = ` LIMIT ${ph()}`; params.push(opts.limitNum); }
    if (opts.offsetNum != null) { offsetClause = ` OFFSET ${ph()}`; params.push(opts.offsetNum); }
    const orderClause = opts.orderBySql ? ` ORDER BY ${opts.orderBySql}` : "";
    return { sql: `SELECT ${opts.selectList} FROM ${esc(opts.table)} AS t0${opts.joinsSql ?? ""} WHERE ${opts.whereSql}${orderClause}${limitClause}${offsetClause}`, params };
  },

  buildJoinClause(join: RelationJoinInfo): string {
    return ` LEFT JOIN ${quoteId(join.targetTable)} AS ${quoteId(join.alias)} ON ${quoteId("t0")}.${quoteId(join.foreignKey)} = ${quoteId(join.alias)}.${quoteId(join.targetPk)}`;
  },
};
