/**
 * SQLite dialect: compilation and schema translation.
 */

import type {
  IrNode,
  IrBinary,
  IrUnary,
  IrMember,
  IrConst,
  IrParam,
  IrIn,
  IrCall,
  IrOrderBy,
  IrSelect,
} from "../../ir/types.js";
import type { CompileOptions, CompileResult, ColumnDef, DialectImpl, CompileSelectOpts } from "../types.js";
import { getColumnDef } from "../types.js";

const DEFAULT_OPTS: Required<CompileOptions> = {
  tableAlias: "t0",
  paramToAlias: { u: "t0", t: "t0", e: "t0" },
};

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function compileNode(
  node: IrNode,
  opts: Required<CompileOptions>,
  params: unknown[],
  placeholder: string
): string {
  switch (node.kind) {
    case "binary": {
      const left = compileNode(node.left, opts, params, placeholder);
      const right = compileNode(node.right, opts, params, placeholder);
      const op =
        node.op === "==" || node.op === "==="
          ? "="
          : node.op === "!=" || node.op === "!=="
            ? "<>"
            : node.op;
      if (op === "&&") return `(${left} AND ${right})`;
      if (op === "||") return `(${left} OR ${right})`;
      return `(${left} ${op} ${right})`;
    }
    case "unary": {
      const operand = compileNode(node.operand, opts, params, placeholder);
      return `(NOT ${operand})`;
    }
    case "member": {
      const alias = opts.paramToAlias?.[node.param] ?? opts.tableAlias ?? "t0";
      const col = node.path.map(quoteId).join(".");
      return `${quoteId(alias)}.${col}`;
    }
    case "const":
      params.push(node.value);
      return placeholder;
    case "param":
      params.push({ __param: node.key });
      return placeholder;
    case "in": {
      const left = compileNode(node.left, opts, params, placeholder);
      if (node.right.kind === "const" && Array.isArray(node.right.value)) {
        const list = node.right.value;
        if (list.length === 0) return "1=0";
        list.forEach((v) => params.push(v));
        return `${left} IN (${list.map(() => placeholder).join(", ")})`;
      }
      if (node.right.kind === "param") {
        params.push({ __param: node.right.key });
        return `${left} IN (${placeholder})`;
      }
      throw new Error("IN right side must be const array or param");
    }
    case "call": {
      const receiver = compileNode(node.receiver, opts, params, placeholder);
      if (node.method === "startsWith") {
        const arg = compileNode(node.args[0], opts, params, placeholder);
        return `(${receiver} LIKE ${arg} || '%')`;
      }
      if (node.method === "endsWith") {
        const arg = compileNode(node.args[0], opts, params, placeholder);
        return `(${receiver} LIKE '%' || ${arg})`;
      }
      if (node.method === "includes") {
        const arg = compileNode(node.args[0], opts, params, placeholder);
        return `(${receiver} LIKE '%' || ${arg} || '%')`;
      }
      throw new Error(`Unsupported method: ${node.method}`);
    }
    default:
      throw new Error(`Unknown IR node: ${(node as { kind: string }).kind}`);
  }
}

export const sqliteDialect: DialectImpl = {
  name: "sqlite",

  escapeIdentifier(name: string): string {
    return '"' + String(name).replace(/"/g, '""') + '"';
  },

  placeholder(index: number): string {
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
    const opts = { ...DEFAULT_OPTS, ...options };
    const params: unknown[] = [];
    const sql = node ? compileNode(node, opts, params, "?") : "1=1";
    return { sql, params };
  },

  compileOrderBy(orders: IrOrderBy[], options: CompileOptions = {}): string {
    if (orders.length === 0) return "";
    const opts = { ...DEFAULT_OPTS, ...options };
    return orders
      .map((o) => {
        const alias = opts.paramToAlias?.[o.param] ?? opts.tableAlias ?? "t0";
        const col = o.path.map(quoteId).join(".");
        const dir = o.direction === "desc" ? "DESC" : "ASC";
        return `${quoteId(alias)}.${col} ${dir}`;
      })
      .join(", ");
  },

  compileSelectList(
    select: IrSelect | null,
    columns: string[],
    options: CompileOptions = {}
  ): string {
    const opts = { ...DEFAULT_OPTS, ...options };
    const alias = select?.param
      ? opts.paramToAlias?.[select.param] ?? opts.tableAlias ?? "t0"
      : opts.tableAlias ?? "t0";
    const base = quoteId(alias);
    if (!select || select.paths.length === 0) {
      return columns.map((c) => `${base}.${quoteId(c)}`).join(", ");
    }
    const aliases = select.aliases;
    const explicitParts = select.paths.map((path, i) => {
      const col = `${base}.${path.map(quoteId).join(".")}`;
      return aliases?.[i] !== undefined ? `${col} AS ${quoteId(aliases[i])}` : col;
    });
    if (select.rest) {
      const explicitCols = new Set(select.paths.map((p) => p[0]));
      const restCols = columns.filter((c) => !explicitCols.has(c));
      const restParts = restCols.map((c) => `${base}.${quoteId(c)}`);
      return [...explicitParts, ...restParts].join(", ");
    }
    return explicitParts.join(", ");
  },

  toColumnDef(def: ColumnDef): string {
    return getColumnDef(def, "sqlite");
  },

  compileInsert(table: string, columns: string[], values: unknown[], pk?: string): CompileResult {
    const esc = quoteId;
    if (columns.length === 0) return { sql: `INSERT INTO ${esc(table)} DEFAULT VALUES`, params: [] };
    const ph = columns.map(() => "?").join(", ");
    const sql = `INSERT INTO ${esc(table)} (${columns.map(esc).join(", ")}) VALUES (${ph})`;
    return { sql, params: values };
  },

  compileCount(table: string, whereSql: string, whereParams: unknown[]): CompileResult {
    const esc = quoteId;
    return { sql: `SELECT COUNT(*) AS c FROM ${esc(table)} AS t0 WHERE ${whereSql}`, params: whereParams };
  },

  compileUpdate(
    table: string,
    set: Record<string, unknown>,
    columns: string[],
    whereSql: string,
    whereParams: unknown[]
  ): CompileResult {
    const cols = Object.keys(set).filter((k) => columns.includes(k));
    const params = cols.map((c) => set[c]);
    if (cols.length === 0) return { sql: "", params: [] };
    const esc = quoteId;
    const assignments = cols.map((c) => `${esc(c)} = ?`).join(", ");
    const fixedWhere = whereSql.replace(/"t0"\./g, `${esc(table)}.`);
    return { sql: `UPDATE ${esc(table)} SET ${assignments} WHERE ${fixedWhere}`, params: [...params, ...whereParams] };
  },

  compileDelete(table: string, whereSql: string, whereParams: unknown[]): CompileResult {
    const esc = quoteId;
    const fixedWhere = whereSql.replace(/"t0"\./g, `${esc(table)}.`);
    return { sql: `DELETE FROM ${esc(table)} WHERE ${fixedWhere}`, params: whereParams };
  },

  compileSelect(opts: CompileSelectOpts): CompileResult {
    const esc = quoteId;
    const params = [...opts.whereParams];
    const ph = (i: number) => "?";
    let limitClause = "";
    let offsetClause = "";
    if (opts.limitNum != null) {
      limitClause = ` LIMIT ${ph(1)}`;
      params.push(opts.limitNum);
    }
    if (opts.offsetNum != null) {
      offsetClause = ` OFFSET ${ph(1)}`;
      params.push(opts.offsetNum);
    }
    const orderClause = opts.orderBySql ? ` ORDER BY ${opts.orderBySql}` : "";
    const sql = `SELECT ${opts.selectList} FROM ${esc(opts.table)} AS t0 WHERE ${opts.whereSql}${orderClause}${limitClause}${offsetClause}`;
    return { sql, params };
  },
};
