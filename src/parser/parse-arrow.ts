/**
 * Runtime parser: arrow function source → IR.
 *
 * Supports a safe subset: comparisons, &&, ||, !, member access, literals,
 * identifiers (params), allowed methods (startsWith/endsWith/includes),
 * .some()/.every() subqueries, aggregates (SUM/AVG/MIN/MAX/COUNT/…), and
 * select lambdas including nested relation sub-selects and query chains.
 */

import * as acorn from "acorn";
import type {
  IrNode,
  IrBinary,
  IrUnary,
  IrMember,
  IrConst,
  IrParam,
  IrIn,
  IrCall,
  IrExists,
  IrSelect,
  IrSelectRelation,
  IrAggregate,
  IrWhere,
} from "../ir/types.js";

// Acorn's typed AST is opaque; internally we access node properties defensively.
type N = acorn.Node & Record<string, any>;

// ---------------------------------------------------------------------------
// Tables / constants
// ---------------------------------------------------------------------------

const AGGREGATE_FUNC_MAP: Record<string, string> = {
  groupconcat: "GROUP_CONCAT",
  stringagg: "STRING_AGG",
  arrayagg: "ARRAY_AGG",
  jsonagg: "JSON_AGG",
};

const AGGREGATE_IR_FUNCS = new Set([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT",
  "GROUP_CONCAT",
  "STRING_AGG",
  "ARRAY_AGG",
  "JSON_AGG",
]);

const BINARY_OPS: Record<string, IrBinary["op"] | undefined> = {
  "&&": "&&",
  "||": "||",
  "==": "==",
  "===": "===",
  "!=": "!=",
  "!==": "!==",
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
};

const ALLOWED_METHODS = new Set(["startsWith", "endsWith", "includes"]);
const RELATION_QUERY_METHODS = new Set(["query", "where", "orderBy", "limit", "offset", "select"]);
const DEFAULT_ROW_PARAM = "u";

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

/** True if `node` is an Identifier; if `name` is given, also checks it matches. */
function isIdent(node: N | null | undefined, name?: string): boolean {
  if (!node || node.type !== "Identifier") return false;
  return name === undefined || node.name === name;
}

/** True if `node` is any acorn Literal (string, number, boolean, null, regex). */
function isLiteral(node: N | null | undefined): boolean {
  return !!node && node.type === "Literal";
}

/** True if `node` is a string literal. */
function isStringLiteral(node: N): boolean {
  return node.type === "Literal" && typeof node.value === "string";
}

/** True if `node` is a numeric literal. */
function isNumberLiteral(node: N): boolean {
  return node.type === "Literal" && typeof node.value === "number";
}

/** Normalize a JS stub identifier (e.g. "groupConcat") to its canonical IR func name. */
function toIrFuncName(rawName: string): string {
  return AGGREGATE_FUNC_MAP[rawName.toLowerCase()] ?? rawName.toUpperCase();
}

/** Parse a single JS expression source string into an acorn AST node; throws on failure. */
function parseExpressionSource(src: string): N {
  const ast = acorn.parse(src, { ecmaVersion: "latest", locations: true }) as any;
  const expr = ast.body?.[0]?.expression;
  if (!expr) throw new Error("Expected expression: " + src);
  return expr as N;
}

/** Slice the original source text covered by an acorn node using its start/end offsets. */
function sliceNodeSource(node: N, source: string): string | null {
  if (typeof node.start !== "number" || typeof node.end !== "number") return null;
  return source.slice(node.start, node.end);
}

// ---------------------------------------------------------------------------
// Arrow source helpers (string-level)
// ---------------------------------------------------------------------------

/**
 * Extract the body expression source from an arrow function's `toString()`.
 * Supports expression bodies and single-`return` block bodies.
 */
function extractArrowBody(src: string): string | null {
  const idx = src.indexOf("=>");
  if (idx === -1) return null;
  const body = src.slice(idx + 2).trim();
  if (!body.startsWith("{")) return body;

  const inner = body.slice(1, -1).trim();
  const returnMatch = inner.match(/^return\s+(.+);?\s*$/s);
  if (!returnMatch) return null;
  return returnMatch[1].replace(/;\s*$/, "").trim();
}

/**
 * Parse parameter names out of an arrow's source text, handling
 * `async` prefixes, parenthesized lists, and inline type annotations.
 * Returns `["u"]` if nothing can be inferred.
 */
function inferParamNames(src: string): string[] {
  const idx = src.indexOf("=>");
  if (idx === -1) return ["u"];

  let before = src
    .slice(0, idx)
    .replace(/^\s*async\s+/, "")
    .trim();
  if (before.startsWith("(") && before.endsWith(")")) {
    before = before.slice(1, -1);
  }
  if (!before) return ["u"];

  const names = before
    .split(",")
    .map((p) => p.trim().split(/[\s:]/)[0])
    .filter(Boolean);
  return names.length > 0 ? names : ["u"];
}

// ---------------------------------------------------------------------------
// Member-path resolution — `u.author.name` → { param: "u", path: [author, name] }
// ---------------------------------------------------------------------------

/**
 * Walk a MemberExpression chain rooted at one of `params` and return the
 * parameter name and the property path. Returns null if the chain isn't
 * rooted at a known parameter or uses computed/non-identifier accesses.
 */
function resolveMemberPath(node: N, params: string[]): { param: string; path: string[] } | null {
  if (node.type === "Identifier" && params.includes(node.name ?? "")) {
    return { param: node.name, path: [] };
  }
  if (node.type !== "MemberExpression" || node.computed) return null;

  const prop = node.property as N;
  if (!prop || prop.type !== "Identifier") return null;

  const parent = resolveMemberPath(node.object as N, params);
  if (!parent) return null;
  return { param: parent.param, path: [...parent.path, prop.name] };
}

/** Same as resolveMemberPath but constrained to a single parameter name. */
function resolvePathFromParam(node: N, paramName: string): string[] | null {
  const resolved = resolveMemberPath(node, [paramName]);
  return resolved ? resolved.path : null;
}

// ---------------------------------------------------------------------------
// Public API: parseArrowToGroupByPaths — groupBy lambdas
// ---------------------------------------------------------------------------

/**
 * Parse a `.groupBy(...)` arrow into an array of member paths and/or
 * positional column references.
 *
 * Supported shapes:
 * - `o => o.category`              → `[["category"]]`
 * - `o => 1`                       → `[1]` (positional)
 * - `o => [o.a, o.b, 2]`           → `[["a"], ["b"], 2]`
 *
 * Returns an empty array for unrecognized shapes.
 */
export function parseArrowToGroupByPaths(fn: (...args: any[]) => any): Array<string[] | number> {
  const src = fn.toString();
  const idx = src.indexOf("=>");
  if (idx === -1) return [];

  const body = src.slice(idx + 2).trim();
  const paramName = src.slice(0, idx).replaceAll(/[()]/g, "").trim() || "u";

  let expr: N;
  try {
    expr = parseExpressionSource(body);
  } catch {
    return [];
  }

  return extractGroupByEntries(expr, paramName);
}

/** Dispatch groupBy body expression to the right extractor for its shape. */
function extractGroupByEntries(expr: N, paramName: string): Array<string[] | number> {
  // o => 1 — positional column reference
  if (isNumberLiteral(expr)) return [expr.value as number];

  // o => o.category — single member path
  if (expr.type === "MemberExpression") {
    const path = resolvePathFromParam(expr, paramName);
    return path && path.length > 0 ? [path] : [];
  }

  // o => [o.category, o.status, 1] — mix of member paths and positionals
  if (expr.type === "ArrayExpression") {
    return collectGroupByArrayElements(expr.elements ?? [], paramName);
  }

  return [];
}

/**
 * Collect member paths and positional literals from an ArrayExpression body.
 * Elements that don't match either shape are silently skipped.
 */
function collectGroupByArrayElements(elements: N[], paramName: string): Array<string[] | number> {
  const entries: Array<string[] | number> = [];
  for (const el of elements) {
    if (!el) continue;
    if (isNumberLiteral(el)) {
      entries.push(el.value as number);
      continue;
    }
    const path = resolvePathFromParam(el, paramName);
    if (path && path.length > 0) entries.push(path);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public API: parseArrowToIr — where predicates
// ---------------------------------------------------------------------------

export interface ParseOptions {
  paramNames?: string[];
  paramKeys?: string[];
  subqueryKeys?: string[];
}

/**
 * Parse a `.where()` / `.having()` arrow predicate into an IR tree.
 * Throws on unsupported syntax — callers typically fall back to evaluating
 * the arrow at runtime if parsing fails.
 */
export function parseArrowToIr(fn: (...args: any[]) => any, options: ParseOptions = {}): IrNode {
  return parseArrowToIrPredicate(fn, options).node;
}

export function parseArrowToIrPredicate(
  fn: (...args: any[]) => any,
  options: ParseOptions = {},
): IrWhere {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) throw new Error("Could not extract arrow body: " + src);

  const expr = parseExpressionSource(body);
  const params = resolveParamsFromOptions(src, options);

  return {
    node: walk(expr, params, options.paramKeys ?? [], options.subqueryKeys ?? []),
    rootParam: params[0] ?? DEFAULT_ROW_PARAM,
    localParamNames: params,
  };
}

/** Pick the effective parameter names from explicit options or inference. */
function resolveParamsFromOptions(src: string, options: ParseOptions): string[] {
  if (options.paramNames) return options.paramNames;
  return inferParamNames(src);
}

// ---------------------------------------------------------------------------
// AST walker: acorn node → IrNode (dispatch + one handler per node kind)
// ---------------------------------------------------------------------------

/**
 * Recursively convert an acorn expression node into an IR node.
 * Dispatches to a per-kind handler; throws on unsupported shapes.
 */
function walk(node: N, params: string[], paramKeys: string[], subqueryKeys: string[]): IrNode {
  switch (node.type) {
    case "BinaryExpression":
    case "LogicalExpression":
      return walkBinaryLike(node, params, paramKeys, subqueryKeys);

    case "UnaryExpression":
      return walkUnary(node, params, paramKeys, subqueryKeys);

    case "MemberExpression":
      return walkMember(node, params);

    case "Identifier":
      return walkIdentifier(node, params, paramKeys);

    case "Literal":
      return { kind: "const", value: node.value } as IrConst;

    case "CallExpression":
      return walkCall(node, params, paramKeys, subqueryKeys);

    case "ArrayExpression":
      return walkArrayLiteral(node, params, paramKeys, subqueryKeys);

    default:
      throw new Error("Unsupported node type: " + node.type);
  }
}

/** Handle BinaryExpression / LogicalExpression — includes `in` → IrIn. */
function walkBinaryLike(
  node: N,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrNode {
  if (node.operator === "in") {
    const left = walk(node.left as N, params, paramKeys, subqueryKeys);
    const rhs = node.right as N;
    if (rhs.type === "Identifier") {
      const name = (rhs.name as string) ?? "";
      if (subqueryKeys.includes(name)) {
        return { kind: "in", left, right: { kind: "subqueryRef", key: name } } as IrIn;
      }
    }
    const right = walk(rhs, params, paramKeys, subqueryKeys);
    return { kind: "in", left, right } as IrIn;
  }

  const left = walk(node.left as N, params, paramKeys, subqueryKeys);
  const right = walk(node.right as N, params, paramKeys, subqueryKeys);
  const op = BINARY_OPS[node.operator];
  if (!op) throw new Error("Unsupported binary operator: " + node.operator);
  return { kind: "binary", op, left, right } as IrBinary;
}

/** Handle `!expr` — only logical-not is supported; collapses `!(x in y)`. */
function walkUnary(node: N, params: string[], paramKeys: string[], subqueryKeys: string[]): IrNode {
  if (node.operator !== "!") throw new Error("Unsupported unary: " + node.operator);

  const inner = walk((node.argument ?? node.operand) as N, params, paramKeys, subqueryKeys);

  // Optimization: !(x in arr) → flip the IrIn's negated flag rather than
  // wrapping with an IrUnary. The query layer can then emit NOT IN directly.
  if (inner.kind === "in") return { ...inner, negated: !inner.negated };

  return { kind: "unary", op: "!", operand: inner } as IrUnary;
}

/** Handle a MemberExpression — resolves to IrMember or throws. */
function walkMember(node: N, params: string[]): IrMember {
  const resolved = resolveMemberPath(node, params);
  if (!resolved) throw new Error("Unsupported member expression");
  return { kind: "member", param: resolved.param, path: resolved.path };
}

/** Handle a bare identifier — either a parameter, a closure param key, or an error. */
function walkIdentifier(node: N, params: string[], paramKeys: string[]): IrNode {
  const name = node.name ?? "";
  if (params.includes(name)) return { kind: "member", param: name, path: [] } as IrMember;
  if (paramKeys.includes(name)) return { kind: "param", key: name } as IrParam;
  throw new Error("Unknown identifier (not param or entity): " + name);
}

/** Handle `[a, b, c]` — allowed only for IN right-hand-sides, contents must be constant. */
function walkArrayLiteral(
  node: N,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrConst {
  const elements = (node.elements ?? []) as N[];
  const values = elements.map((e) => {
    if (!e || e.type === "SpreadElement") throw new Error("Unsupported array element");
    const ir = walk(e, params, paramKeys, subqueryKeys);
    if (ir.kind !== "const") throw new Error("IN array must contain literals");
    return ir.value;
  });
  return { kind: "const", value: values };
}

// ---- CallExpression dispatch -----------------------------------------------

/**
 * Handle `CallExpression` nodes. Identifier callees must be aggregate
 * functions; member callees may be `.some()/.every()` subqueries or one of
 * the allowed string methods. Throws on anything else.
 */
function walkCall(node: N, params: string[], paramKeys: string[], subqueryKeys: string[]): IrNode {
  const callee = node.callee as N;

  // Identifier callee: only aggregates (SUM, COUNT, groupConcat, …) allowed.
  if (callee.type === "Identifier") {
    const aggregate = tryParseAggregate(
      node,
      params,
      paramKeys,
      { strictDistinct: true },
      subqueryKeys,
    );
    if (aggregate) return aggregate.ir;
    throw new Error("Unsupported call expression");
  }

  if (callee.type !== "MemberExpression") {
    throw new Error("Unsupported call expression");
  }

  const method = (callee.property as N)?.name as string | undefined;

  // Subqueries: relation.some(...) / .every(...)
  const exists = tryParseSomeEvery(node, method, params, paramKeys, subqueryKeys);
  if (exists) return exists;

  // Allowed string methods: startsWith / endsWith / includes
  if (!method || !ALLOWED_METHODS.has(method)) {
    throw new Error("Unsupported method: " + method);
  }
  return {
    kind: "call",
    method,
    receiver: walk(callee.object as N, params, paramKeys, subqueryKeys),
    args: ((node.arguments ?? []) as N[]).map((a) => walk(a, params, paramKeys, subqueryKeys)),
  } as IrCall;
}

// ---- .some() / .every() ----------------------------------------------------

/**
 * Parse a relation-collection `.some(cb)` or `.every(cb)` call into an
 * `IrExists` subquery. `.every` is represented as a negated exists.
 * Returns null when the shape isn't a subquery call.
 */
function tryParseSomeEvery(
  node: N,
  method: string | undefined,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrExists | null {
  if (method !== "some" && method !== "every") return null;

  const args = (node.arguments ?? []) as N[];
  if (args.length !== 1) return null;

  const callee = node.callee as N;
  const receiver = resolveMemberPath(callee.object as N, params);
  if (!receiver || receiver.path.length < 1) return null;

  const cb = args[0];
  if (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression") return null;

  const innerParam = ((cb.params?.[0] as N)?.name as string) ?? "e";
  const innerExpr = extractCallbackExpression(cb.body as N, method);
  const innerWhere = walk(innerExpr, [innerParam], paramKeys, subqueryKeys);

  return {
    kind: "exists",
    ...(method === "every" ? { negated: true } : {}),
    rootParam: receiver.param,
    relationKey: receiver.path[0],
    innerParam,
    innerWhere,
  } as IrExists;
}

/**
 * Extract the inner expression from a `.some()/.every()` callback body.
 * Supports expression bodies and block bodies whose first statement exposes
 * an `.expression` field. Throws on other shapes.
 */
function extractCallbackExpression(body: N, method: string): N {
  if (body?.type === "BlockStatement") {
    const first = (body.body as N[])?.[0];
    const expr = first?.expression as N | undefined;
    if (!expr) throw new Error(`Unsupported .${method}() callback: need return`);
    return expr;
  }
  if (!body) throw new Error(`Unsupported .${method}() callback body`);
  return body;
}

// ---------------------------------------------------------------------------
// Aggregate call parsing — shared by walk() and select-lambda parsing
// ---------------------------------------------------------------------------

interface AggregateParseResult {
  ir: IrAggregate; // no alias set — caller assigns it
  rawName: string; // original identifier text, e.g. "count" or "groupConcat"
}

/**
 * Parse SUM/AVG/MIN/MAX/COUNT/groupConcat/stringAgg/… calls.
 * Returns null if the callee is not a recognized aggregate identifier.
 *
 * When `strictDistinct` is true, malformed `distinct(...)` wrappers throw.
 * When false (select-lambda contexts), they are swallowed so the caller can
 * fall through to other parsing strategies (e.g. relation query chains).
 */
function tryParseAggregate(
  callNode: N,
  params: string[],
  paramKeys: string[],
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): AggregateParseResult | null {
  const callee = callNode.callee as N;
  if (!callee || callee.type !== "Identifier") return null;

  const rawName = (callee.name as string) ?? "";
  const funcName = toIrFuncName(rawName);
  if (!AGGREGATE_IR_FUNCS.has(funcName)) return null;

  const args = (callNode.arguments ?? []) as N[];
  const { arg, distinct } = parseAggregateArg(
    args[0] ?? null,
    params,
    paramKeys,
    rawName,
    opts,
    subqueryKeys,
  );
  const separator = parseAggregateSeparator(funcName, args);

  const ir: IrAggregate = {
    kind: "aggregate",
    func: funcName as IrAggregate["func"],
    arg,
    ...(distinct ? { distinct: true } : {}),
    ...(separator !== undefined ? { separator } : {}),
  };
  return { ir, rawName };
}

/**
 * Parse an aggregate's first argument, handling the optional
 * `distinct(...)` wrapper. Non-distinct argument errors are swallowed to a
 * null arg (historic behavior); distinct errors respect `opts.strictDistinct`.
 */
function parseAggregateArg(
  argNode: N | null,
  params: string[],
  paramKeys: string[],
  rawName: string,
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): { arg: IrNode | null; distinct: boolean } {
  if (!argNode) return { arg: null, distinct: false };

  // distinct(expr) wrapper — e.g. count(distinct(p.id))
  if (argNode.type === "CallExpression" && isIdent(argNode.callee as N, "distinct")) {
    return parseDistinctWrapper(argNode, params, paramKeys, rawName, opts, subqueryKeys);
  }

  // Regular expression argument — swallow walk errors to null (matches legacy).
  try {
    return { arg: walk(argNode, params, paramKeys, subqueryKeys), distinct: false };
  } catch {
    return { arg: null, distinct: false };
  }
}

/**
 * Parse the inner expression of a `distinct(expr)` wrapper.
 * In strict mode, missing/unparseable inner expressions throw; in lenient
 * mode they return `{ arg: null, distinct: false }` so callers can fall back.
 */
function parseDistinctWrapper(
  distinctCall: N,
  params: string[],
  paramKeys: string[],
  rawName: string,
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): { arg: IrNode | null; distinct: boolean } {
  const inner = ((distinctCall.arguments ?? []) as N[])[0];

  if (!inner) {
    if (opts.strictDistinct) {
      throw new Error(
        `Unsupported DISTINCT aggregate expression in ${rawName}(): missing inner argument`,
      );
    }
    return { arg: null, distinct: false };
  }

  try {
    return { arg: walk(inner, params, paramKeys, subqueryKeys), distinct: true };
  } catch {
    if (opts.strictDistinct) {
      throw new Error(
        `Unsupported DISTINCT aggregate expression in ${rawName}(): could not parse distinct(...) argument`,
      );
    }
    return { arg: null, distinct: false };
  }
}

/**
 * Extract the string-literal separator argument of `GROUP_CONCAT` /
 * `STRING_AGG`; returns undefined for other aggregates or missing separators.
 */
function parseAggregateSeparator(funcName: string, args: N[]): string | undefined {
  if (funcName !== "GROUP_CONCAT" && funcName !== "STRING_AGG") return undefined;
  if (args.length < 2) return undefined;
  const sep = args[1];
  return isStringLiteral(sep) ? (sep.value as string) : undefined;
}

// ---------------------------------------------------------------------------
// Public API: parseArrowToIrSelect — select lambdas
// ---------------------------------------------------------------------------

/**
 * Parse a `.select()` arrow into an `IrSelect` describing columns, nested
 * relations, aggregates, and/or rest-spread. Returns null if the arrow's
 * shape cannot be mapped onto the supported select subset.
 */
/**
 * Strip outer parens from `({ … })` bodies and wrap in `(…)` so the source
 * parses as an expression (object literal) rather than a block statement.
 */
function normalizeSelectBodySource(body: string): string {
  const inner = body.startsWith("(") && body.endsWith(")") ? body.slice(1, -1) : body;
  return `(${inner})`;
}

export function parseArrowToIrSelect(fn: (...args: any[]) => any): IrSelect | null {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) return null;

  const paramName = inferParamNames(src)[0] ?? "u";

  // We keep `fullSrc` around so nested arrow callbacks (inside relation
  // query chains) can be re-materialized via start/end offsets.
  const fullSrc = normalizeSelectBodySource(body);

  let expr: N;
  try {
    expr = parseExpressionSource(fullSrc);
  } catch {
    return null;
  }

  return parseTopLevelSelectExpression(expr, paramName, fullSrc);
}

/**
 * Parse an `.update(e => ({ col: e.cte.other_col, ... }))` arrow into a map
 * of column names to IR nodes (member paths or literals).
 */
export function parseArrowToUpdateSet(
  fn: (...args: any[]) => Record<string, unknown>,
): Record<string, IrNode> {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) throw new Error("update lambda must be an arrow function");

  const paramName = inferParamNames(src)[0] ?? DEFAULT_ROW_PARAM;
  const expr = parseExpressionSource(body.startsWith("(") ? body : `(${body})`);
  if (expr.type !== "ObjectExpression") {
    throw new Error("update lambda must return an object literal");
  }

  const result: Record<string, IrNode> = {};
  for (const raw of (expr.properties ?? []) as N[]) {
    if (raw.type !== "Property" || raw.computed) {
      throw new Error("update object keys must be identifiers");
    }
    const keyNode = raw.key as N;
    const keyName =
      keyNode?.type === "Identifier"
        ? (keyNode.name as string)
        : keyNode?.type === "Literal" && typeof keyNode.value === "string"
          ? keyNode.value
          : null;
    if (!keyName) throw new Error("update object keys must be identifiers");

    const value = raw.value as N | undefined;
    if (!value) throw new Error(`update: missing value for "${keyName}"`);
    if (value.type === "MemberExpression") {
      const resolved = resolveMemberPath(value, [paramName]);
      if (!resolved || resolved.path.length === 0) {
        throw new Error(
          `update "${keyName}": expected ${paramName}.<column> or ${paramName}.<cte>.<column>`,
        );
      }
      result[keyName] = { kind: "member", param: resolved.param, path: resolved.path };
      continue;
    }
    if (isLiteral(value)) {
      result[keyName] = { kind: "const", value: value.value };
      continue;
    }
    throw new Error(`update "${keyName}": value must be a column reference or literal`);
  }

  if (Object.keys(result).length === 0) {
    throw new Error("update lambda must set at least one column");
  }
  return result;
}

/**
 * Dispatch the top-level expression of a select arrow to the matching
 * handler: bare param (SELECT *), single member, single aggregate, or
 * object literal.
 */
function parseTopLevelSelectExpression(
  expr: N,
  paramName: string,
  fullSrc: string,
): IrSelect | null {
  // p => p  →  SELECT *
  if (isIdent(expr, paramName)) {
    return { param: paramName, paths: [], aliases: [], rest: true };
  }

  // p => p.id  →  single column
  if (expr.type === "MemberExpression") {
    return parseSingleColumnSelect(expr, paramName);
  }

  // p => count(p.id)  →  single aggregate
  if (expr.type === "CallExpression") {
    return parseSingleAggregateSelect(expr, paramName);
  }

  // p => ({ … })  →  object literal of paths / relations / aggregates
  if (expr.type === "ObjectExpression") {
    return parseSelectObjectLiteral(expr, paramName, fullSrc);
  }

  return null;
}

/** Build an IrSelect for `p => p.x.y` — single column aliased to the last path segment. */
function parseSingleColumnSelect(expr: N, paramName: string): IrSelect | null {
  const resolved = resolveMemberPath(expr, [paramName]);
  if (!resolved || resolved.path.length === 0) return null;
  const alias = resolved.path[resolved.path.length - 1];
  return { param: paramName, paths: [resolved.path], aliases: [alias] };
}

/** Build an IrSelect for `p => count(p.id)` — single aggregate aliased to the lowercased func name. */
function parseSingleAggregateSelect(callNode: N, paramName: string): IrSelect | null {
  const parsed = safeParseAggregate(callNode, paramName);
  if (!parsed) return null;

  const alias = parsed.rawName.toLowerCase();
  return {
    param: paramName,
    paths: [],
    aliases: [],
    aggregates: [{ ...parsed.ir, alias }],
  };
}

/** Lenient (select-lambda) aggregate parser — never throws. */
function safeParseAggregate(callNode: N, paramName: string): AggregateParseResult | null {
  try {
    return tryParseAggregate(callNode, [paramName], [], { strictDistinct: false }, []);
  } catch {
    return null;
  }
}

// ---- Select object literal --------------------------------------------------

/**
 * Parse an object-literal select body, collecting columns, relations,
 * aggregates, and rest-spread markers into a single `IrSelect`.
 */
function parseSelectObjectLiteral(obj: N, paramName: string, fullSrc: string): IrSelect | null {
  const paths: string[][] = [];
  const aliases: string[] = [];
  const relations: IrSelectRelation[] = [];
  const aggregates: IrAggregate[] = [];
  let rest = false;

  for (const raw of obj.properties as N[]) {
    if (raw.type === "SpreadElement") {
      // Only `...p` rest is supported. Anything else = bail.
      if (!isIdent(raw.argument as N, paramName)) return null;
      rest = true;
      continue;
    }

    if (raw.type !== "Property" || raw.computed) return null;

    const keyName = (raw.key as N)?.name ?? (raw.key as N)?.value;
    if (typeof keyName !== "string") return null;

    const value = raw.value as N | undefined;
    if (!value) return null;

    const handled = parseSelectProperty(value, keyName, paramName, fullSrc);
    if (!handled) return null;

    applySelectPropertyResult(handled, keyName, paths, aliases, relations, aggregates);
  }

  if (paths.length === 0 && relations.length === 0 && aggregates.length === 0 && !rest) {
    return null;
  }

  const result: IrSelect = { param: paramName, paths, aliases };
  if (relations.length > 0) result.relations = relations;
  if (rest) result.rest = true;
  if (aggregates.length > 0) result.aggregates = aggregates;
  return result;
}

type SelectPropertyResult =
  | { kind: "path"; path: string[] }
  | { kind: "relation"; relation: IrSelectRelation }
  | { kind: "aggregate"; aggregate: IrAggregate };

/**
 * Classify a single `{ key: value }` entry in a select object literal as a
 * path, a relation (nested object or query chain), or an aggregate.
 */
function parseSelectProperty(
  value: N,
  keyName: string,
  paramName: string,
  fullSrc: string,
): SelectPropertyResult | null {
  // { author: { id: p.author.id, name: p.author.name } } → nested relation sub-select
  if (value.type === "ObjectExpression") {
    return parseNestedRelationProperty(value, keyName, paramName);
  }

  // { total: SUM(p.amount) }   — aggregate, OR
  // { posts: p.author.query().where(…) } — relation query chain
  if (value.type === "CallExpression") {
    return parseCallSelectProperty(value, keyName, paramName, fullSrc);
  }

  // { name: p.name } / { authorName: p.author.name }
  const resolved = resolveMemberPath(value, [paramName]);
  if (!resolved || resolved.path.length === 0) return null;
  return { kind: "path", path: resolved.path };
}

/**
 * Parse a nested object literal property value as a relation sub-select
 * (all values must be `paramName.<relation>.<field>`).
 */
function parseNestedRelationProperty(
  value: N,
  keyName: string,
  paramName: string,
): SelectPropertyResult | null {
  const sub = parseRelationSubSelect(value, paramName);
  if (!sub) return null;
  return {
    kind: "relation",
    relation: { name: sub.relation, outputKey: keyName, subPaths: sub.subPaths },
  };
}

/**
 * Parse a CallExpression property value — first try as an aggregate, then
 * fall back to a relation query chain (`p.author.query().where(...)`).
 */
function parseCallSelectProperty(
  value: N,
  keyName: string,
  paramName: string,
  fullSrc: string,
): SelectPropertyResult | null {
  const parsed = safeParseAggregate(value, paramName);
  if (parsed) {
    return { kind: "aggregate", aggregate: { ...parsed.ir, alias: keyName } };
  }

  const relation = parseRelationQueryChain(value, paramName, keyName, fullSrc);
  if (!relation) return null;
  return { kind: "relation", relation };
}

/** Push a parsed property result into the appropriate accumulator bucket. */
function applySelectPropertyResult(
  result: SelectPropertyResult,
  keyName: string,
  paths: string[][],
  aliases: string[],
  relations: IrSelectRelation[],
  aggregates: IrAggregate[],
): void {
  switch (result.kind) {
    case "path":
      paths.push(result.path);
      aliases.push(keyName);
      return;
    case "relation":
      relations.push(result.relation);
      return;
    case "aggregate":
      aggregates.push(result.aggregate);
      return;
  }
}

// ---------------------------------------------------------------------------
// Nested relation sub-selects — { author: { id: p.author.id, name: p.author.name } }
// ---------------------------------------------------------------------------

/**
 * Parse a nested object literal like `{ id: p.author.id, name: p.author.name }`
 * into `{ relation: "author", subPaths: [["id"], ["name"]] }`. All values
 * must share the same root relation name; returns null otherwise.
 */
function parseRelationSubSelect(
  obj: N,
  paramName: string,
): { relation: string; subPaths: string[][] } | null {
  const subPaths: string[][] = [];
  let relation: string | null = null;

  for (const raw of obj.properties as N[]) {
    if (raw.type !== "Property" || raw.computed) return null;

    const keyName = (raw.key as N)?.name ?? (raw.key as N)?.value;
    if (typeof keyName !== "string") return null;

    const value = raw.value as N | undefined;
    if (!value) return null;

    const resolved = resolveMemberPath(value, [paramName]);
    // Need at least two path components — first is the relation name,
    // the rest is the column path inside the related entity.
    if (!resolved || resolved.path.length < 2) return null;

    const rel = resolved.path[0];
    if (relation !== null && relation !== rel) return null;
    relation = rel;
    subPaths.push(resolved.path.slice(1));
  }

  if (!relation || subPaths.length === 0) return null;
  return { relation, subPaths };
}

// ---------------------------------------------------------------------------
// Relation query chains — relation.query().where(...).orderBy(...).limit(n)
// ---------------------------------------------------------------------------

interface ChainMethod {
  name: string;
  args: N[];
}

/**
 * Parse a `p.<relation>.query().where(...).orderBy(...).limit(n)` style
 * chain into an `IrSelectRelation` with attached sub-query options.
 * Returns null for any unsupported shape.
 */
function parseRelationQueryChain(
  node: N,
  parentParamName: string,
  outputKey: string,
  source: string,
): IrSelectRelation | null {
  const chain = collectChainMethods(node);
  if (!chain) return null;

  const headPath = resolveMemberPath(chain.head, [parentParamName]);
  if (!headPath || headPath.path.length !== 1) return null;

  const result: IrSelectRelation = { name: headPath.path[0], outputKey };

  for (const method of chain.methods) {
    if (!applyChainMethod(method, result, source)) return null;
  }
  return result;
}

/**
 * Walk down a chain of `.method(...)` calls until we hit a non-call node
 * (the "head" — should be a member expression referring to a relation).
 * Returns the methods in outer→inner order.
 */
function collectChainMethods(node: N): { methods: ChainMethod[]; head: N } | null {
  const methods: ChainMethod[] = [];
  let current: N | null = node;

  while (current && current.type === "CallExpression") {
    const callee = current.callee as N;
    if (!callee || callee.type !== "MemberExpression") return null;

    const methodName = (callee.property as N)?.name as string | undefined;
    if (!methodName || !RELATION_QUERY_METHODS.has(methodName)) return null;

    methods.push({ name: methodName, args: (current.arguments ?? []) as N[] });
    current = (callee.object as N) ?? null;
  }

  if (!current || current.type !== "MemberExpression") return null;
  return { methods, head: current };
}

/** Dispatch a single chain method to its specific applier; returns false on error. */
function applyChainMethod(method: ChainMethod, result: IrSelectRelation, source: string): boolean {
  switch (method.name) {
    case "query":
      return method.args.length === 0;
    case "where":
      return applyWhereMethod(method.args, result, source);
    case "orderBy":
      return applyOrderByMethod(method.args, result);
    case "limit":
      return applyLimitOrOffsetMethod(method.args, result, "limit");
    case "offset":
      return applyLimitOrOffsetMethod(method.args, result, "offset");
    case "select":
      return applySelectMethod(method.args, result, source);
    default:
      return false;
  }
}

/**
 * Apply a `.where(arrow)` chain method: re-materialize the arrow source
 * via offsets, eval it back to a function, and parse it via `parseArrowToIr`.
 */
function applyWhereMethod(args: N[], result: IrSelectRelation, source: string): boolean {
  if (args.length !== 1 || args[0].type !== "ArrowFunctionExpression") return false;

  const argSrc = sliceNodeSource(args[0], source);
  if (!argSrc) return false;

  try {
    const whereFn = new Function("return " + argSrc)();
    const paramNames = inferParamNames(argSrc);
    result.whereIr = parseArrowToIrPredicate(whereFn, { paramNames });
    result.whereParams = {};
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply an `.orderBy(column[, dir])` chain method. The column must be a
 * literal (stringified) and the optional direction a string literal; defaults
 * to ascending when direction is missing or not "desc".
 */
function applyOrderByMethod(args: N[], result: IrSelectRelation): boolean {
  if (args.length < 1 || args.length > 2) return false;

  const colNode = args[0];
  if (!isLiteral(colNode)) return false;
  const col = String(colNode.value);
  if (!col) return false;

  const dir = args.length === 2 && args[1].value === "desc" ? "desc" : "asc";
  result.orderBy = result.orderBy ?? [];
  result.orderBy.push({
    expr: { kind: "member", param: "u", path: [col] },
    direction: dir,
  });
  return true;
}

/** Apply `.limit(n)` or `.offset(n)` — both require a single finite non-negative literal. */
function applyLimitOrOffsetMethod(
  args: N[],
  result: IrSelectRelation,
  kind: "limit" | "offset",
): boolean {
  if (args.length !== 1) return false;

  const node = args[0];
  if (!isLiteral(node)) return false;

  const n = Number(node.value);
  if (!Number.isFinite(n) || n < 0) return false;

  if (kind === "limit") result.limitNum = Math.floor(n);
  else result.offsetNum = Math.floor(n);
  return true;
}

/**
 * Apply a `.select(arrow)` chain method by reparsing the nested lambda via
 * `parseArrowToIrSelect` and lifting its paths into the enclosing relation.
 */
function applySelectMethod(args: N[], result: IrSelectRelation, source: string): boolean {
  if (args.length !== 1 || args[0].type !== "ArrowFunctionExpression") return false;

  const argSrc = sliceNodeSource(args[0], source);
  if (!argSrc) return false;

  try {
    const selectFn = new Function("return " + argSrc)();
    const sub = parseArrowToIrSelect(selectFn);
    if (!sub || !sub.paths.length) return false;
    result.subPaths = sub.paths;
    return true;
  } catch {
    return false;
  }
}
