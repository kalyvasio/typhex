/**
 * Shared IR compilation logic for SQL dialects.
 *
 * Owns traversal and logical decisions: operator normalization, path/alias
 * resolution, IN list building, relation alias lookup.
 *
 * Dialect-specific rendering (EXISTS, LIKE, aggregates, placeholders) is
 * provided by the dialect object passed to makeCompileNode().
 */

import type { IrNode, IrBinary, IrMember, IrConst, IrExists, IrOrderBy, IrSelect, IrAggregate } from "../ir/types.js";
import type { CompileOptions, DialectImpl, ResolvedOpts } from "./types.js";

export const DEFAULT_OPTS: CompileOptions = {
  tableAlias: "t0",
  paramToAlias: { u: "t0", t: "t0", e: "t0" },
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

/** Resolve the SQL expression for an aggregate argument.
 *  Handles: null → *, member → quoted column, numeric const → literal, complex → compileNodeFn. */
export function compileAggregateArg(
  arg: IrNode | null,
  opts?: ResolvedOpts,
  compileNodeFn?: (node: IrNode, opts: ResolvedOpts, params: unknown[]) => string,
  params?: unknown[]
): string {
  if (arg === null) return "*";
  if (arg.kind === "member") {
    const m = arg as IrMember;
    let alias = opts ? (opts.paramToAlias[m.param] ?? opts.tableAlias) : "t0";
    let path = m.path;
    if (opts?.relationPathToAlias && path.length >= 1) {
      const relAlias = opts.relationPathToAlias[`${m.param}.${path[0]}`];
      if (relAlias) { alias = relAlias; path = path.slice(1); }
    }
    return `${quoteId(alias ?? "t0")}.${quoteId(path[path.length - 1])}`;
  }
  if (arg.kind === "const" && typeof (arg as IrConst).value === "number") {
    return String((arg as IrConst).value);
  }
  if (compileNodeFn && opts) {
    return compileNodeFn(arg, opts, params ?? []);
  }
  throw new Error(`[typhex] Aggregate arg of kind "${arg.kind}" requires a compile context. Use a member expression, a numeric literal, or ensure the aggregate is used within a full query (HAVING/WHERE).`);
}

/** Compile FUNC(DISTINCT? arg) — the standard single-argument aggregate shape.
 *  Used for ARRAY_AGG, JSON_AGG, and internally by the cross-dialect compileAggregate. */
export function compileStandardAggregate(
  funcName: string,
  agg: IrAggregate,
  opts?: ResolvedOpts,
  compileNodeFn?: (node: IrNode, opts: ResolvedOpts, params: unknown[]) => string,
  params?: unknown[]
): string {
  const argSql = compileAggregateArg(agg.arg, opts, compileNodeFn, params);
  const distinctPrefix = agg.distinct ? "DISTINCT " : "";
  const expr = `${funcName}(${distinctPrefix}${argSql})`;
  return agg.alias ? `${expr} AS ${quoteId(agg.alias)}` : expr;
}

/** Compile FUNC(DISTINCT? arg[, 'sep']) — the string-concatenation aggregate shape.
 *  Used for GROUP_CONCAT (SQLite) and STRING_AGG (Postgres).
 *
 *  defaultSep:
 *    undefined — omit the separator argument entirely when agg.separator is not set (SQLite)
 *    string    — always emit a separator argument, falling back to this value (Postgres "','") */
export function compileConcatAggregate(
  funcName: string,
  agg: IrAggregate,
  defaultSep: string | undefined,
  opts?: ResolvedOpts,
  compileNodeFn?: (node: IrNode, opts: ResolvedOpts, params: unknown[]) => string,
  params?: unknown[]
): string {
  const argSql = compileAggregateArg(agg.arg, opts, compileNodeFn, params);
  const distinctPrefix = agg.distinct ? "DISTINCT " : "";
  const sepLiteral =
    agg.separator !== undefined
      ? `'${agg.separator.replace(/'/g, "''")}'`
      : defaultSep;
  const inner =
    sepLiteral !== undefined
      ? `${distinctPrefix}${argSql}, ${sepLiteral}`
      : `${distinctPrefix}${argSql}`;
  const expr = `${funcName}(${inner})`;
  return agg.alias ? `${expr} AS ${quoteId(agg.alias)}` : expr;
}

/** Shared aggregate compilation for cross-dialect functions (SUM/AVG/MIN/MAX/COUNT).
 *  Dialect-specific functions (GROUP_CONCAT, STRING_AGG, ARRAY_AGG, etc.) are handled
 *  by each dialect's dialect.compileAggregate override. */
export function compileAggregate(
  agg: IrAggregate,
  opts?: ResolvedOpts,
  compileNodeFn?: (node: IrNode, opts: ResolvedOpts, params: unknown[]) => string,
  params?: unknown[]
): string {
  const CROSS_DIALECT = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT"]);
  if (!CROSS_DIALECT.has(agg.func)) {
    throw new Error(`[typhex] Aggregate function "${agg.func}" is dialect-specific. Import it from the corresponding dialect and use with the matching database.`);
  }
  return compileStandardAggregate(agg.func, agg, opts, compileNodeFn, params);
}


/** Compile a GROUP BY clause body from an array of paths/positional references.
 *  string[] entries are resolved via alias lookup (same pattern as compileOrderBy).
 *  number entries are emitted as positional column references (GROUP BY 1).
 *  The root param is derived automatically from paramToAlias + relationPathToAlias. */
export function compileGroupBy(
  paths: Array<string[] | number>,
  opts: ResolvedOpts
): string {
  return paths.map((entry) => {
    if (typeof entry === "number") return String(entry);
    if (entry.length === 0) throw new Error("[typhex] GROUP BY path cannot be empty");
    if (entry.length === 1) return `${quoteId(opts.tableAlias)}.${quoteId(entry[0])}`;
    // Multi-segment: scan known params to find the join alias
    if (opts.relationPathToAlias) {
      for (const param of Object.keys(opts.paramToAlias)) {
        const relAlias = opts.relationPathToAlias[`${param}.${entry[0]}`];
        if (relAlias) return `${quoteId(relAlias)}.${entry.slice(1).map(quoteId).join(".")}`;
      }
    }
    // No join alias found: fall back to main table with full path
    return `${quoteId(opts.tableAlias)}.${entry.map(quoteId).join(".")}`;
  }).join(", ");
}

export function makeCompileNode(dialect: DialectImpl) {
  function compileNode(node: IrNode, opts: ResolvedOpts, params: unknown[]): string {
    switch (node.kind) {
      case "binary": {
        const b = node;
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
        return dialect.placeholder(params.length);
      case "param":
        params.push({ __param: node.key });
        return dialect.placeholder(params.length);
      case "in": {
        const left = compileNode(node.left, opts, params);
        const op = node.negated ? "NOT IN" : "IN";
        if (node.right.kind === "const" && Array.isArray(node.right.value)) {
          const list = node.right.value;
          if (list.length === 0) return node.negated ? "1=1" : "1=0";
          const placeholders = list.map(v => { params.push(v); return dialect.placeholder(params.length); });
          return `${left} ${op} (${placeholders.join(", ")})`;
        }
        if (node.right.kind === "param") {
          params.push({ __param: node.right.key });
          return `${left} ${op} (${dialect.placeholder(params.length)})`;
        }
        throw new Error("IN right side must be const array or param");
      }
      case "exists": {
        const ex = node;
        const info = opts.oneToManyExists?.[`${ex.rootParam}.${ex.relationKey}`];
        if (!info) throw new Error(`No oneToManyExists info for ${ex.rootParam}.${ex.relationKey}`);
        const innerOpts = { ...opts, paramToAlias: { ...opts.paramToAlias, [ex.innerParam]: info.alias } };
        const innerSql = compileNode(ex.innerWhere, innerOpts, params);
        const wrappedSql = ex.negated ? `(NOT (${innerSql}))` : innerSql;
        const existsSql = dialect.compileExists(info.targetTable, info.alias, info.fkColumn, opts.tableAlias, info.mainPk, wrappedSql);
        return ex.negated ? `(NOT ${existsSql})` : existsSql;
      }
      case "call": {
        const receiver = compileNode(node.receiver, opts, params);
        const method = node.method;
        if (method === "startsWith" || method === "endsWith" || method === "includes") {
          const arg = compileNode(node.args[0], opts, params);
          return dialect.compileLike(receiver, arg, method);
        }
        throw new Error(`Unsupported method: ${method}`);
      }
      case "aggregate":
        return dialect.compileAggregate?.(node as IrAggregate, opts, compileNode, params)
          ?? compileAggregate(node as IrAggregate, opts, compileNode, params);
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
  options: CompileOptions = {},
  compileAggFn: (agg: IrAggregate, opts: ResolvedOpts) => string = compileAggregate
): string {
  const opts = resolveOpts(options);
  const rootAlias = select?.param
    ? opts.paramToAlias?.[select.param] ?? opts.tableAlias ?? "t0"
    : opts.tableAlias ?? "t0";
  const base = quoteId(rootAlias);
  const aggParts = select?.aggregates && select.aggregates.length > 0
    ? select.aggregates.map(agg => compileAggFn(agg, opts))
    : [];
  if (!select || select.paths.length === 0) {
    if (aggParts.length > 0 && (!select || !select.rest)) {
      return aggParts.join(", ");
    }
    const baseParts = columns.map((c) => `${base}.${quoteId(c)}`);
    return [...baseParts, ...aggParts].join(", ");
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
    return [...explicitParts, restCols.map((c) => `${base}.${quoteId(c)}`), ...aggParts].flat().join(", ");
  }
  return [...explicitParts, ...aggParts].join(", ");
}
