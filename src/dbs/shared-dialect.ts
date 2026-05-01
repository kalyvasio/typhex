/**
 * Shared IR compilation logic for SQL dialects.
 *
 * Owns traversal and logical decisions: operator normalization, path/alias
 * resolution, IN list building, relation alias lookup.
 *
 * Dialect-specific rendering (EXISTS, LIKE, aggregates, placeholders) is
 * provided by the dialect object passed to makeCompileNode().
 */

import type { IrNode, IrOrderBy, IrSelect, IrAggregate, IrSubquery } from "../ir/types.js";
import { validateIrSubquery } from "../ir/types.js";
import type { CompileOptions, DialectImpl, ResolvedOpts } from "./types.js";

export const DEFAULT_OPTS: CompileOptions = {
  tableAlias: "t0",
  paramToAlias: { u: "t0", t: "t0", e: "t0" },
};

export function quoteId(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Resolve the SQL alias and remaining column path for `<param>.<path...>`,
 *  honoring `relationPathToAlias` rewrites.
 *
 *  `minPathLenForRewrite` is normally 1 (any single-segment path that matches
 *  a relation key is rewritten). ORDER BY uses 2 — `u.company` should remain
 *  on the main table even when `company` is a relation key. */
export function resolveColumnAlias(
  param: string,
  path: string[],
  opts: ResolvedOpts,
  minPathLenForRewrite = 1,
): { alias: string; path: string[] } {
  let alias = opts.paramToAlias[param] ?? opts.tableAlias;
  let p = path;
  if (path.length >= minPathLenForRewrite && opts.relationPathToAlias) {
    const relAlias = opts.relationPathToAlias[`${param}.${path[0]}`];
    if (relAlias) {
      alias = relAlias;
      p = path.slice(1);
    }
  }
  return { alias: alias ?? "t0", path: p };
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
  params?: unknown[],
): string {
  if (arg === null) return "*";
  if (arg.kind === "member") {
    if (opts) {
      const { alias, path } = resolveColumnAlias(arg.param, arg.path, opts);
      return `${quoteId(alias)}.${quoteId(path[path.length - 1])}`;
    }
    return `${quoteId("t0")}.${quoteId(arg.path[arg.path.length - 1])}`;
  }
  if (arg.kind === "const" && typeof arg.value === "number") {
    return String(arg.value);
  }
  if (compileNodeFn && opts) {
    return compileNodeFn(arg, opts, params ?? []);
  }
  throw new Error(
    `[typhex] Aggregate arg of kind "${arg.kind}" requires a compile context. Use a member expression, a numeric literal, or ensure the aggregate is used within a full query (HAVING/WHERE).`,
  );
}

/** Compile FUNC(DISTINCT? arg) — the standard single-argument aggregate shape.
 *  Used for ARRAY_AGG, JSON_AGG, and internally by the cross-dialect compileAggregate. */
export function compileStandardAggregate(
  funcName: string,
  agg: IrAggregate,
  opts?: ResolvedOpts,
  compileNodeFn?: (node: IrNode, opts: ResolvedOpts, params: unknown[]) => string,
  params?: unknown[],
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
  params?: unknown[],
): string {
  const argSql = compileAggregateArg(agg.arg, opts, compileNodeFn, params);
  const distinctPrefix = agg.distinct ? "DISTINCT " : "";
  const sepLiteral =
    agg.separator !== undefined ? `'${agg.separator.replaceAll("'", "''")}'` : defaultSep;
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
  params?: unknown[],
): string {
  const CROSS_DIALECT = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT"]);
  if (!CROSS_DIALECT.has(agg.func)) {
    throw new Error(
      `[typhex] Aggregate function "${agg.func}" is dialect-specific. Import it from the corresponding dialect and use with the matching database.`,
    );
  }
  return compileStandardAggregate(agg.func, agg, opts, compileNodeFn, params);
}

/** Compile a GROUP BY clause body from an array of paths/positional references.
 *  string[] entries are resolved via alias lookup (same pattern as compileOrderBy).
 *  number entries are emitted as positional column references (GROUP BY 1).
 *  The root param is derived automatically from paramToAlias + relationPathToAlias. */
export function compileGroupBy(paths: Array<string[] | number>, opts: ResolvedOpts): string {
  return paths
    .map((entry) => {
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
    })
    .join(", ");
}

type CompileNodeFn = (node: IrNode, opts: ResolvedOpts, params: unknown[]) => string;

function compileInNode(
  node: IrNode & { kind: "in" },
  opts: ResolvedOpts,
  params: unknown[],
  dialect: DialectImpl,
  compileNode: CompileNodeFn,
): string {
  const left = compileNode(node.left, opts, params);
  const op = node.negated ? "NOT IN" : "IN";
  if (node.right.kind === "const" && Array.isArray(node.right.value)) {
    const list = node.right.value;
    if (list.length === 0) return node.negated ? "1=1" : "1=0";
    const placeholders = list.map((v) => {
      params.push(v);
      return dialect.placeholder(params.length);
    });
    return `${left} ${op} (${placeholders.join(", ")})`;
  }
  if (node.right.kind === "param") {
    params.push({ __param: node.right.key });
    return `${left} ${op} (${dialect.placeholder(params.length)})`;
  }
  if (node.right.kind === "subquery") {
    if (!node.right.selectCol) {
      throw new Error("[typhex] Subquery on right side of IN must specify selectCol");
    }
    return `${left} ${op} ${compileSubqueryExpr(node.right, opts, params, compileNode)}`;
  }
  throw new Error("IN right side must be const array, param, or subquery");
}

/** Pick the next free `t<N>` alias not already used by paramToAlias or
 *  relationPathToAlias values. Avoids collisions with relation JOIN aliases
 *  (which start at t1) and with nested subquery aliases. */
function nextFreeAlias(opts: ResolvedOpts): string {
  const used = new Set<string>();
  used.add(opts.tableAlias);
  for (const a of Object.values(opts.paramToAlias)) used.add(a);
  if (opts.relationPathToAlias) {
    for (const a of Object.values(opts.relationPathToAlias)) used.add(a);
  }
  for (let i = 1; ; i++) {
    const candidate = `t${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

function compileExistsNode(
  node: IrNode & { kind: "exists" },
  opts: ResolvedOpts,
  params: unknown[],
  dialect: DialectImpl,
  compileNode: CompileNodeFn,
): string {
  const info = opts.oneToManyExists?.[`${node.rootParam}.${node.relationKey}`];
  if (!info) throw new Error(`No oneToManyExists info for ${node.rootParam}.${node.relationKey}`);
  const innerOpts = {
    ...opts,
    paramToAlias: { ...opts.paramToAlias, [node.innerParam]: info.alias },
  };
  const innerSql = compileNode(node.innerWhere, innerOpts, params);
  const wrappedSql = node.negated ? `(NOT (${innerSql}))` : innerSql;
  const existsSql = dialect.compileExists(
    info.targetTable,
    info.alias,
    info.fkColumns,
    opts.tableAlias,
    info.mainPk,
    wrappedSql,
  );
  return node.negated ? `(NOT ${existsSql})` : existsSql;
}

export function makeCompileNode(dialect: DialectImpl) {
  function compileNode(node: IrNode, opts: ResolvedOpts, params: unknown[]): string {
    switch (node.kind) {
      case "binary": {
        const left = compileNode(node.left, opts, params);
        const right = compileNode(node.right, opts, params);
        const op =
          node.op === "==" || node.op === "==="
            ? "="
            : node.op === "!=" || node.op === "!=="
              ? "<>"
              : node.op;
        if (node.op === "&&") return `(${left} AND ${right})`;
        if (node.op === "||") return `(${left} OR ${right})`;
        return `(${left} ${op} ${right})`;
      }
      case "unary":
        return `(NOT ${compileNode(node.operand, opts, params)})`;
      case "member": {
        const { alias, path } = resolveColumnAlias(node.param, node.path, opts);
        if (path.length === 0) return quoteId(alias);
        return `${quoteId(alias)}.${path.map(quoteId).join(".")}`;
      }
      case "const":
        params.push(node.value);
        return dialect.placeholder(params.length);
      case "param":
        params.push({ __param: node.key });
        return dialect.placeholder(params.length);
      case "in":
        return compileInNode(node, opts, params, dialect, compileNode);
      case "exists":
        return compileExistsNode(node, opts, params, dialect, compileNode);
      case "subquery":
        return compileSubqueryExpr(node, opts, params, compileNode);
      case "call": {
        const receiver = compileNode(node.receiver, opts, params);
        if (
          node.method === "startsWith" ||
          node.method === "endsWith" ||
          node.method === "includes"
        ) {
          const arg = compileNode(node.args[0], opts, params);
          return dialect.compileLike(receiver, arg, node.method);
        }
        throw new Error(`Unsupported method: ${node.method}`);
      }
      case "aggregate":
        return (
          dialect.compileAggregate?.(node, opts, compileNode, params) ??
          compileAggregate(node, opts, compileNode, params)
        );
      default:
        throw new Error(`Unknown IR node: ${(node as { kind: string }).kind}`);
    }
  }
  return compileNode;
}

export function compileOrderBy(
  orders: IrOrderBy[],
  options: CompileOptions = {},
  dialect?: DialectImpl,
): { sql: string; params: unknown[] } {
  if (orders.length === 0) return { sql: "", params: [] };
  const opts = resolveOpts(options);
  const params: unknown[] = [];
  const compileNode = dialect ? makeCompileNode(dialect) : null;
  const sql = orders
    .map((o) => {
      const dir = o.direction === "desc" ? "DESC" : "ASC";
      // Member exprs use the dedicated renderer to preserve historical
      // single-segment-path semantics (`u.company` → `"t0"."company"`,
      // not the relation join's alias). compileNode would treat any
      // `param.relationKey` as a relation rewrite even for length-1 paths.
      if (o.expr.kind === "member") {
        return `${renderOrderByMember(o.expr, opts)} ${dir}`;
      }
      if (!compileNode) {
        throw new Error(
          "[typhex] compileOrderBy needs a dialect to compile non-member sort expressions",
        );
      }
      return `${compileNode(o.expr, opts, params)} ${dir}`;
    })
    .join(", ");
  return { sql, params };
}

/** Render an IrMember expression as the resolved column reference for ORDER BY,
 *  honoring relation alias rewrites (`u.company.name` → `"t1"."name"`). */
function renderOrderByMember(expr: IrNode & { kind: "member" }, opts: ResolvedOpts): string {
  // ORDER BY uses minPathLenForRewrite=2 so a length-1 path like `u.company`
  // stays on the main table even when `company` is also a relation key —
  // historic behavior we preserve to match snapshot expectations.
  const { alias, path } = resolveColumnAlias(expr.param, expr.path, opts, 2);
  return `${quoteId(alias)}.${path.map(quoteId).join(".")}`;
}

export function compileSelectList(
  select: IrSelect | null,
  columns: string[],
  options: CompileOptions = {},
  compileAggFn: (agg: IrAggregate, opts: ResolvedOpts) => string = compileAggregate,
  dialect?: DialectImpl,
): { sql: string; params: unknown[] } {
  const opts = resolveOpts(options);
  const params: unknown[] = [];
  const rootAlias = select?.param
    ? (opts.paramToAlias?.[select.param] ?? opts.tableAlias ?? "t0")
    : (opts.tableAlias ?? "t0");
  const base = quoteId(rootAlias);
  const aggParts =
    select?.aggregates && select.aggregates.length > 0
      ? select.aggregates.map((agg) => compileAggFn(agg, opts))
      : [];
  const subqueryParts =
    select?.subqueries && select.subqueries.length > 0 && dialect
      ? select.subqueries.map((entry) =>
          compileSelectListSubquery(entry.alias, entry.subquery, opts, params, dialect),
        )
      : [];
  if (!select || select.paths.length === 0) {
    if ((aggParts.length > 0 || subqueryParts.length > 0) && (!select || !select.rest)) {
      return { sql: [...aggParts, ...subqueryParts].join(", "), params };
    }
    const baseParts = columns.map((c) => `${base}.${quoteId(c)}`);
    return { sql: [...baseParts, ...aggParts, ...subqueryParts].join(", "), params };
  }
  const aliases = select.aliases;
  const explicitParts = select.paths.map((path, i) => {
    const resolved = select?.param
      ? resolveColumnAlias(select.param, path, opts)
      : { alias: rootAlias, path };
    const { alias, path: p } = resolved;
    if (p.length === 0) return quoteId(alias);
    const col = `${quoteId(alias)}.${p.map(quoteId).join(".")}`;
    return aliases?.[i] !== undefined ? `${col} AS ${quoteId(aliases[i])}` : col;
  });
  if (select.rest) {
    const explicitCols = new Set(select.paths.map((p) => p[0]));
    const restCols = columns.filter((c) => !explicitCols.has(c));
    return {
      sql: [
        ...explicitParts,
        restCols.map((c) => `${base}.${quoteId(c)}`),
        ...aggParts,
        ...subqueryParts,
      ]
        .flat()
        .join(", "),
      params,
    };
  }
  return { sql: [...explicitParts, ...aggParts, ...subqueryParts].join(", "), params };
}

/** Render the projection clause for a subquery (the bit between SELECT and FROM).
 *  Pure presentation: relies on `validateIrSubquery` having been called so we can
 *  trust the IR is well-formed. */
function renderSubqueryProjection(sub: IrSubquery, subAlias: string): string {
  const distinctCol =
    sub.distinct && typeof sub.distinct === "object" ? sub.distinct.col : undefined;
  if (sub.aggregate) {
    const { func, valueCol } = sub.aggregate;
    const col = distinctCol ?? valueCol;
    if (col === undefined) return "COUNT(*)";
    const inner = `${quoteId(subAlias)}.${quoteId(col)}`;
    return `${func}(${distinctCol !== undefined ? "DISTINCT " : ""}${inner})`;
  }
  // selectCol form (validated)
  const distinctPrefix = sub.distinct === true ? "DISTINCT " : "";
  return `${distinctPrefix}${quoteId(subAlias)}.${quoteId(sub.selectCol!)}`;
}

/** Compile a scalar subquery as a parenthesized SQL expression:
 *    (SELECT <agg or col> FROM <table> AS <alias> WHERE <cond>)
 *
 *  The IR is expected to be well-formed (call `validateIrSubquery` upstream).
 *  Correlated outer references are taken verbatim from `sub.outerCorrelatedParams`
 *  (resolved against `outerOpts.paramToAlias`); inner row params come from
 *  `sub.innerParamNames` and resolve to the subquery's own alias. */
function compileSubqueryExpr(
  sub: IrSubquery,
  outerOpts: ResolvedOpts,
  outerParams: unknown[],
  compileNode: CompileNodeFn,
): string {
  validateIrSubquery(sub);
  const subAlias = nextFreeAlias(outerOpts);

  const subParamToAlias: Record<string, string> = {};
  for (const n of sub.innerParamNames ?? []) subParamToAlias[n] = subAlias;
  const outerParamToAlias: Record<string, string> = {};
  for (const n of sub.outerCorrelatedParams ?? []) {
    const a = outerOpts.paramToAlias[n];
    if (a) outerParamToAlias[n] = a;
  }
  const subOpts: ResolvedOpts = {
    tableAlias: subAlias,
    // Inner names win over outer; outer paramToAlias is included as a fallback
    // for legacy callers that don't populate outerCorrelatedParams (matches the
    // pre-refactor "merge outer into sub" behavior).
    paramToAlias: { ...outerOpts.paramToAlias, ...outerParamToAlias, ...subParamToAlias },
    relationPathToAlias: {},
    oneToManyExists: {},
  };
  const whereSql = sub.whereIr ? compileNode(sub.whereIr, subOpts, outerParams) : "1=1";

  const projection = renderSubqueryProjection(sub, subAlias);

  let tail = "";
  if (sub.orderBy && sub.orderBy.length > 0) {
    const parts = sub.orderBy.map((o) => {
      const dir = o.direction === "desc" ? "DESC" : "ASC";
      const exprSql = compileNode(o.expr, subOpts, outerParams);
      return `${exprSql} ${dir}`;
    });
    tail += ` ORDER BY ${parts.join(", ")}`;
  }
  if (sub.limitNum !== undefined) tail += ` LIMIT ${sub.limitNum}`;
  if (sub.offsetNum !== undefined) tail += ` OFFSET ${sub.offsetNum}`;

  return `(SELECT ${projection} FROM ${quoteId(sub.tableName)} AS ${quoteId(subAlias)} WHERE ${whereSql}${tail})`;
}

/** Compile a scalar-subquery column for a SELECT list — the expression form
 *  with an `AS "<alias>"` suffix. */
function compileSelectListSubquery(
  outputAlias: string,
  sub: IrSubquery,
  outerOpts: ResolvedOpts,
  outerParams: unknown[],
  dialect: DialectImpl,
): string {
  const compileNode = makeCompileNode(dialect);
  return `${compileSubqueryExpr(sub, outerOpts, outerParams, compileNode)} AS ${quoteId(outputAlias)}`;
}
