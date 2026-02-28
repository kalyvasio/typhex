/**
 * Compiles query IR to parameterized SQL fragments.
 * Dialect: SQLite-friendly (?, ?1, ?2); can be extended for PostgreSQL ($1, $2).
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
} from "../ir/types.js";

export interface CompileResult {
  /** SQL fragment (e.g. WHERE clause without "WHERE") */
  sql: string;
  /** Ordered list of values for placeholders */
  params: unknown[];
}

export interface CompileOptions {
  /** Table alias used for the main entity (e.g. "t0") */
  tableAlias?: string;
  /** Map param name (e.g. "u") to table alias */
  paramToAlias?: Record<string, string>;
  /** Placeholder style: "?" for SQLite */
  placeholder?: "?";
}

const DEFAULT_OPTIONS: CompileOptions = {
  tableAlias: "t0",
  paramToAlias: { u: "t0", t: "t0", e: "t0" },
  placeholder: "?",
};

/** Escape a SQL identifier (table/column name) for safe interpolation. */
export function escapeIdentifier(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function compileWhere(
  node: IrNode | null,
  options: CompileOptions = {}
): CompileResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const params: unknown[] = [];
  const sql = node ? compileNode(node, opts, params) : "1=1";
  return { sql, params };
}

function compileNode(
  node: IrNode,
  opts: CompileOptions,
  params: unknown[]
): string {
  switch (node.kind) {
    case "binary":
      return compileBinary(node, opts, params);
    case "unary":
      return compileUnary(node, opts, params);
    case "member":
      return compileMember(node, opts);
    case "const":
      params.push(node.value);
      return opts.placeholder ?? "?";
    case "param":
      params.push({ __param: node.key });
      return opts.placeholder ?? "?";
    case "in":
      return compileIn(node, opts, params);
    case "call":
      return compileCall(node, opts, params);
    default:
      throw new Error(`Unknown IR node: ${(node as { kind: string }).kind}`);
  }
}

function compileBinary(
  node: IrBinary,
  opts: CompileOptions,
  params: unknown[]
): string {
  const left = compileNode(node.left, opts, params);
  const right = compileNode(node.right, opts, params);
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

function compileUnary(
  node: IrUnary,
  opts: CompileOptions,
  params: unknown[]
): string {
  const operand = compileNode(node.operand, opts, params);
  return `(NOT ${operand})`;
}

function compileMember(node: IrMember, opts: CompileOptions): string {
  const alias =
    opts.paramToAlias?.[node.param] ?? opts.tableAlias ?? "t0";
  const col = node.path.map(quoteId).join(".");
  return `${quoteId(alias)}.${col}`;
}

function compileIn(node: IrIn, opts: CompileOptions, params: unknown[]): string {
  const left = compileNode(node.left, opts, params);
  let list: unknown[];
  if (node.right.kind === "const" && Array.isArray(node.right.value)) {
    list = node.right.value;
  } else if (node.right.kind === "param") {
    params.push({ __param: node.right.key });
    return `${left} IN (${opts.placeholder})`;
  } else {
    throw new Error("IN right side must be const array or param");
  }
  if (list.length === 0) return "1=0";
  const placeholders = list.map(() => {
    params.push(undefined);
    return opts.placeholder;
  });
  list.forEach((v, i) => (params[params.length - list.length + i] = v));
  return `${left} IN (${placeholders.join(", ")})`;
}

function compileCall(
  node: IrCall,
  opts: CompileOptions,
  params: unknown[]
): string {
  const receiver = compileNode(node.receiver, opts, params);
  if (node.method === "startsWith") {
    if (node.args.length < 1) throw new Error("startsWith requires 1 argument");
    const arg = compileNode(node.args[0], opts, params);
    return `(${receiver} LIKE ${arg} || '%')`;
  }
  if (node.method === "endsWith") {
    if (node.args.length < 1) throw new Error("endsWith requires 1 argument");
    const arg = compileNode(node.args[0], opts, params);
    return `(${receiver} LIKE '%' || ${arg})`;
  }
  if (node.method === "includes") {
    if (node.args.length < 1) throw new Error("includes requires 1 argument");
    const arg = compileNode(node.args[0], opts, params);
    return `(${receiver} LIKE '%' || ${arg} || '%')`;
  }
  throw new Error(`Unsupported method in IR: ${node.method}`);
}

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function compileOrderBy(
  orderBy: IrOrderBy[],
  options: CompileOptions = {}
): string {
  if (orderBy.length === 0) return "";
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return orderBy
    .map((o) => {
      const alias = opts.paramToAlias?.[o.param] ?? opts.tableAlias ?? "t0";
      const col = o.path.map(quoteId).join(".");
      const dir = o.direction === "desc" ? "DESC" : "ASC";
      return `${quoteId(alias)}.${col} ${dir}`;
    })
    .join(", ");
}

export function compileSelectList(
  select: IrSelect | null,
  columns: string[],
  options: CompileOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const alias = select?.param
    ? opts.paramToAlias?.[select.param] ?? opts.tableAlias ?? "t0"
    : opts.tableAlias ?? "t0";
  const base = quoteId(alias);
  if (!select || select.paths.length === 0) {
    return columns.map((c) => `${base}.${quoteId(c)}`).join(", ");
  }
  const aliases = select.aliases;
  const explicitParts = select.paths
    .map((path, i) => {
      const col = `${base}.${path.map(quoteId).join(".")}`;
      if (aliases && aliases[i] !== undefined) {
        return `${col} AS ${quoteId(aliases[i])}`;
      }
      return col;
    });
  if (select.rest) {
    const explicitCols = new Set(select.paths.map((p) => p[0]));
    const restCols = columns.filter((c) => !explicitCols.has(c));
    const restParts = restCols.map((c) => `${base}.${quoteId(c)}`);
    return [...explicitParts, ...restParts].join(", ");
  }
  return explicitParts.join(", ");
}

const PARAM_SENTINEL = "__param" as const;

export function isParamSentinel(
  p: unknown
): p is { __param: string } {
  return typeof p === "object" && p !== null && PARAM_SENTINEL in p;
}

/** Resolve param placeholders with runtime values. Expands array params for IN. */
export function bindParams(
  result: CompileResult,
  paramValues: Record<string, unknown>
): unknown[] {
  const out: unknown[] = [];
  for (const p of result.params) {
    if (isParamSentinel(p)) {
      const v = paramValues[p.__param];
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Resolve params without flattening arrays (so one ? can expand to many for IN). */
function resolveParamsForExpand(
  params: unknown[],
  paramValues: Record<string, unknown>
): unknown[] {
  const out: unknown[] = [];
  for (const p of params) {
    if (isParamSentinel(p)) {
      out.push(paramValues[p.__param]);
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Flatten IN clause: one ? per array element. Returns final SQL and flat params. */
export function expandInParams(
  sql: string,
  params: unknown[],
  paramValues: Record<string, unknown>
): { sql: string; params: unknown[] } {
  const resolved = resolveParamsForExpand(params, paramValues);
  let idx = 0;
  const newParams: unknown[] = [];
  const newSql = sql.replace(/\?/g, () => {
    const v = resolved[idx++];
    if (Array.isArray(v)) {
      v.forEach((x) => newParams.push(x));
      return v.map(() => "?").join(", ");
    }
    newParams.push(v);
    return "?";
  });
  return { sql: newSql, params: newParams };
}
