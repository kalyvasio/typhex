/**
 * PostgreSQL dialect: compilation and schema translation.
 */

import type {
  CompileResult,
  ColumnDef,
  DialectImpl,
  CompileSelectOpts,
  OnConflictClause,
} from "../types.js";
import type { RelationJoinMeta } from "../../orm/helpers/relations/relation-joins.js";
import type { Expr, ExprAggregate } from "../../orm/expr.js";
import { getColumnDef, SQL_DEFAULT } from "../types.js";
import {
  JOIN_SQL_KEYWORDS,
  quoteId,
  compilePlan as compilePlanShared,
  compileAggregate,
  compileConcatAggregate,
  compileStandardAggregate,
  compileGroupBy,
} from "../shared-dialect.js";

function postgresCompileAggregate(
  agg: ExprAggregate,
  compileNodeFn?: (node: Expr, params: unknown[]) => string,
  params?: unknown[],
): string {
  if (agg.func === "GROUP_CONCAT" || agg.func === "STRING_AGG") {
    return compileConcatAggregate("STRING_AGG", agg, "','", compileNodeFn, params);
  }
  if (agg.func === "ARRAY_AGG" || agg.func === "JSON_AGG") {
    return compileStandardAggregate(agg.func, agg, compileNodeFn, params);
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
  const setClauses = updateCols.map((c) => `${esc(c)} = EXCLUDED.${esc(c)}`).join(", ");
  return `${baseSql} ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClauses}`;
}

export const postgresDialect: DialectImpl = {
  name: "postgres",
  insertCapabilities: {
    supportsReturning: true,
    supportsSequences: false,
  },
  compileNextSequenceValues(): CompileResult {
    throw new Error("Postgres sequence allocation is not configured for this dialect yet");
  },

  escapeIdentifier(name: string): string {
    return '"' + String(name).replaceAll('"', '""') + '"';
  },

  placeholder(index: number): string {
    return `$${index}`;
  },

  expandPlaceholders(
    sql: string,
    resolvedParams: unknown[],
    startIdx = 1,
  ): { sql: string; params: unknown[] } {
    let idx = 0;
    const newParams: unknown[] = [];
    let paramIndex = startIdx;
    const newSql = sql.replaceAll(/\$(\d+)/g, () => {
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

  compilePlan(plan, opts = {}) {
    return compilePlanShared(plan, opts, postgresDialect);
  },

  toColumnDef(def: ColumnDef): string {
    return getColumnDef(def, "postgres");
  },

  compileInsert(
    table: string,
    columns: string[],
    values: unknown[],
    pk?: string[],
    onConflict?: OnConflictClause,
  ): CompileResult {
    const esc = quoteId;
    const hasPk = !!pk?.length;
    if (columns.length === 0) {
      if (onConflict) {
        throw new Error(
          "insert: ON CONFLICT requires explicit columns (empty INSERT not supported with onConflict)",
        );
      }
      return {
        sql: `INSERT INTO ${esc(table)} DEFAULT VALUES${hasPk ? " RETURNING *" : ""}`,
        params: [],
        returningRow: hasPk,
      };
    }
    const ph = columns.map((_, i) => `$${i + 1}`).join(", ");
    let sql = `INSERT INTO ${esc(table)} (${columns.map(esc).join(", ")}) VALUES (${ph})`;
    if (onConflict) sql = appendOnConflict(sql, onConflict, columns, esc);
    if (hasPk) sql += " RETURNING *";
    return { sql, params: values, returningRow: hasPk };
  },

  compileInsertMany(
    table: string,
    columns: string[],
    rows: unknown[][],
    pk?: string[],
    onConflict?: OnConflictClause,
  ): CompileResult {
    const esc = quoteId;
    if (rows.length === 0) {
      return { sql: "", params: [], returningRow: false };
    }
    if (columns.length === 0) {
      return { sql: "", params: [], returningRow: false };
    }
    let paramIdx = 1;
    const params: unknown[] = [];
    const rowPlaceholders = rows.map((row) => {
      const phs = row.map((v) => {
        if (v === SQL_DEFAULT) return "DEFAULT";
        params.push(v);
        return `$${paramIdx++}`;
      });
      return `(${phs.join(", ")})`;
    });
    let sql = `INSERT INTO ${esc(table)} (${columns.map(esc).join(", ")}) VALUES ${rowPlaceholders.join(", ")}`;
    if (onConflict) sql = appendOnConflict(sql, onConflict, columns, esc);
    const hasPk = !!pk?.length;
    if (hasPk) sql += " RETURNING *";
    return { sql, params, returningRow: hasPk };
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
    const assignments = cols.map((c, i) => `${esc(c)} = $${i + 1}`).join(", ");
    const fixedWhere = whereSql.replaceAll('"t0".', `${esc(table)}.`);
    const renumberedWhere = fixedWhere.replaceAll(
      /\$(\d+)/g,
      (_, n) => `$${Number.parseInt(n, 10) + cols.length}`,
    );
    let sql = `UPDATE ${esc(table)} SET ${assignments} WHERE ${renumberedWhere}`;
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
    let paramIdx = (opts.paramStartIndex ?? 1) + params.length;
    const ph = () => `$${paramIdx++}`;
    let limitClause = "";
    let offsetClause = "";
    if (opts.limitNum != null) {
      limitClause = ` LIMIT ${ph()}`;
      params.push(opts.limitNum);
    }
    if (opts.offsetNum != null) {
      offsetClause = ` OFFSET ${ph()}`;
      params.push(opts.offsetNum);
    }
    const orderClause = opts.orderBySql ? ` ORDER BY ${opts.orderBySql}` : "";
    const sql = `SELECT ${opts.selectList} FROM ${esc(opts.table)} AS ${esc(opts.tableAlias)}${opts.joinsSql ?? ""} WHERE ${opts.whereSql}${groupByClause}${havingClause}${orderClause}${limitClause}${offsetClause}`;
    return { sql, params };
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

  compileAggregate: postgresCompileAggregate,

  buildJoinClause(join: RelationJoinMeta, mainAlias: string): string {
    const kw =
      join.joinType === "cross" ? "INNER JOIN" : (JOIN_SQL_KEYWORDS[join.joinType] ?? "LEFT JOIN");
    const on = join.foreignKeys
      .map(
        (fk, i) =>
          `${quoteId(mainAlias)}.${quoteId(fk)} = ${quoteId(join.alias)}.${quoteId(join.targetPkColumns[i] ?? join.targetPkColumns[0])}`,
      )
      .join(" AND ");
    return ` ${kw} ${quoteId(join.targetTable)} AS ${quoteId(join.alias)} ON ${on}`;
  },
};
