/**
 * Shared IR compilation logic for SQL dialects.
 *
 * Owns traversal and logical decisions: operator normalization, path/alias
 * resolution, IN list building, relation alias lookup.
 *
 * Actual SQL rendering for dialect-specific constructs is delegated to a
 * DialectRenderer that each dialect provides to makeCompileNode().
 */

import type { IrNode, IrBinary, IrExists, IrIn, IrOrderBy, IrSelect } from "../ir/types.js";
import type { CompileOptions } from "./types.js";

export const DEFAULT_OPTS: CompileOptions = {
  tableAlias: "t0",
  paramToAlias: { u: "t0", t: "t0", e: "t0" },
};

export type ResolvedOpts = {
  tableAlias: string;
  paramToAlias: Record<string, string>;
  relationPathToAlias?: Record<string, string>;
  oneToManyExists?: Record<string, { targetTable: string; fkColumn: string; mainPk: string; alias: string }>;
};

export function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function resolveOpts(options: CompileOptions): ResolvedOpts {
  const merged = { ...DEFAULT_OPTS, ...options };
  return {
    tableAlias: merged.tableAlias ?? "t0",
    paramToAlias: merged.paramToAlias ?? { u: "t0", t: "t0", e: "t0" },
    relationPathToAlias: merged.relationPathToAlias,
    oneToManyExists: merged.oneToManyExists,
  };
}

/**
 * Dialect-specific SQL rendering.
 * The shared compileNode handles traversal and calls these for SQL output.
 */
export interface DialectRenderer {
  /** Return a placeholder after pushing a value to params. */
  placeholder(params: unknown[]): string;
  /** Render an EXISTS subquery for a one-to-many relation. */
  compileExists(
    targetTable: string,
    alias: string,
    fkColumn: string,
    mainAlias: string,
    mainPk: string,
    innerSql: string
  ): string;
  /** Render a string method (startsWith / endsWith / includes). */
  compileLike(receiver: string, arg: string, mode: "startsWith" | "endsWith" | "includes"): string;
}

export function makeCompileNode(renderer: DialectRenderer) {
  function compileNode(node: IrNode, opts: ResolvedOpts, params: unknown[]): string {
    switch (node.kind) {
      case "binary": {
        const b = node as IrBinary;
        const left = compileNode(b.left, opts, params);
        const right = compileNode(b.right, opts, params);
        const op =
          b.op === "==" || b.op === "===" ? "=" :
          b.op === "!=" || b.op === "!==" ? "<>" :
          b.op;
        if (b.op === "&&") return `(${left} AND ${right})`;
        if (b.op === "||") return `(${left} OR ${right})`;
        return `(${left} ${op} ${right})`;
      }
      case "unary":
        return `(NOT ${compileNode(node.operand, opts, params)})`;
      case "member": {
        let alias = opts.paramToAlias[node.param] ?? opts.tableAlias;
        let path = node.path;
        if (path.length >= 1 && opts.relationPathToAlias) {
          const relAlias = opts.relationPathToAlias[`${node.param}.${path[0]}`];
          if (relAlias) { alias = relAlias; path = path.slice(1); }
        }
        if (path.length === 0) return quoteId(alias);
        return `${quoteId(alias)}.${path.map(quoteId).join(".")}`;
      }
      case "const":
        params.push(node.value);
        return renderer.placeholder(params);
      case "param":
        params.push({ __param: node.key });
        return renderer.placeholder(params);
      case "in": {
        const left = compileNode(node.left, opts, params);
        const op = (node as IrIn & { negated?: boolean }).negated ? "NOT IN" : "IN";
        if (node.right.kind === "const" && Array.isArray(node.right.value)) {
          const list = node.right.value;
          if (list.length === 0) return (node as IrIn & { negated?: boolean }).negated ? "1=1" : "1=0";
          const placeholders = list.map(v => { params.push(v); return renderer.placeholder(params); });
          return `${left} ${op} (${placeholders.join(", ")})`;
        }
        if (node.right.kind === "param") {
          params.push({ __param: node.right.key });
          return `${left} ${op} (${renderer.placeholder(params)})`;
        }
        throw new Error("IN right side must be const array or param");
      }
      case "exists": {
        const ex = node as IrExists;
        const info = opts.oneToManyExists?.[`${ex.rootParam}.${ex.relationKey}`];
        if (!info) throw new Error(`No oneToManyExists info for ${ex.rootParam}.${ex.relationKey}`);
        const innerOpts = { ...opts, paramToAlias: { ...opts.paramToAlias, [ex.innerParam]: info.alias } };
        const innerSql = compileNode(ex.innerWhere, innerOpts, params);
        return renderer.compileExists(info.targetTable, info.alias, info.fkColumn, opts.tableAlias, info.mainPk, innerSql);
      }
      case "call": {
        const receiver = compileNode(node.receiver, opts, params);
        const method = node.method;
        if (method === "startsWith" || method === "endsWith" || method === "includes") {
          const arg = compileNode(node.args[0], opts, params);
          return renderer.compileLike(receiver, arg, method);
        }
        throw new Error(`Unsupported method: ${method}`);
      }
      default:
        throw new Error(`Unknown IR node: ${(node as { kind: string }).kind}`);
    }
  }
  return compileNode;
}

export function compileOrderBy(orders: IrOrderBy[], options: CompileOptions = {}): string {
  if (orders.length === 0) return "";
  const opts = resolveOpts(options);
  return orders
    .map((o) => {
      let tableAlias = opts.paramToAlias?.[o.param] ?? opts.tableAlias ?? "t0";
      let path = o.path;
      if (path.length >= 2 && opts.relationPathToAlias) {
        const relAlias = opts.relationPathToAlias[`${o.param}.${path[0]}`];
        if (relAlias) { tableAlias = relAlias; path = path.slice(1); }
      }
      const col = path.map(quoteId).join(".");
      const dir = o.direction === "desc" ? "DESC" : "ASC";
      return `${quoteId(tableAlias)}.${col} ${dir}`;
    })
    .join(", ");
}

export function compileSelectList(
  select: IrSelect | null,
  columns: string[],
  options: CompileOptions = {}
): string {
  const opts = resolveOpts(options);
  const rootAlias = select?.param
    ? opts.paramToAlias?.[select.param] ?? opts.tableAlias ?? "t0"
    : opts.tableAlias ?? "t0";
  const base = quoteId(rootAlias);
  if (!select || select.paths.length === 0) {
    return columns.map((c) => `${base}.${quoteId(c)}`).join(", ");
  }
  const aliases = select.aliases;
  const explicitParts = select.paths.map((path, i) => {
    let alias = rootAlias;
    let p = path;
    if (path.length >= 1 && opts.relationPathToAlias && select?.param) {
      const relAlias = opts.relationPathToAlias[`${select.param}.${path[0]}`];
      if (relAlias) { alias = relAlias; p = path.slice(1); }
    }
    if (p.length === 0) return quoteId(alias);
    const col = `${quoteId(alias)}.${p.map(quoteId).join(".")}`;
    return aliases?.[i] !== undefined ? `${col} AS ${quoteId(aliases[i])}` : col;
  });
  if (select.rest) {
    const explicitCols = new Set(select.paths.map((p) => p[0]));
    const restCols = columns.filter((c) => !explicitCols.has(c));
    return [...explicitParts, restCols.map((c) => `${base}.${quoteId(c)}`)].flat().join(", ");
  }
  return explicitParts.join(", ");
}
