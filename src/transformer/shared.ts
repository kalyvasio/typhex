/**
 * Shared utilities for Typhex transformers.
 */

import ts from "typescript";
import type {
  IrNode,
  IrSelect,
  IrBinary,
  IrOrderBy,
  IrAggregate,
} from "../ir/types.js";

// ---------------------------------------------------------------------------
// Typhex type detection
// ---------------------------------------------------------------------------

/**
 * True if a type symbol resolves to the Typhex `Table` or `QueryBuilder`
 * class — used as the gate for whether a `.where()`/`.select()`/etc. call
 * should be rewritten by the transformer.
 */
export function checkSymbolIsTyphex(symbol: ts.Symbol): boolean {
  const symbolName = symbol.getName();
  if (symbolName !== "Table" && symbolName !== "QueryBuilder") return false;

  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return false;

  for (const decl of declarations) {
    if (!isTyphexDeclarationFile(decl.getSourceFile().fileName)) return false;
  }
  return true;
}

/** Check whether a source file path points at Typhex's ORM Table/QueryBuilder definitions. */
function isTyphexDeclarationFile(rawPath: string): boolean {
  const normalized = rawPath.replaceAll("\\", "/");
  const inTyphexPackage =
    normalized.includes("/typhex/") || normalized.includes("/typhex\\");
  const inOrmModule =
    normalized.includes("/orm/table") ||
    normalized.includes("/orm/query-builder");
  const hasValidExtension =
    normalized.endsWith(".ts") ||
    normalized.endsWith(".js") ||
    normalized.endsWith(".d.ts");
  return inTyphexPackage && inOrmModule && hasValidExtension;
}

/**
 * True if the receiver expression's resolved type corresponds to a Typhex
 * Table/QueryBuilder. Swallows any checker errors so a compilation-level
 * type resolution failure never blocks the rest of the transform.
 */
export function isTyphexType(
  receiver: ts.Expression,
  checker: ts.TypeChecker
): boolean {
  try {
    const symbol = resolveTypeSymbol(receiver, checker);
    return symbol ? checkSymbolIsTyphex(symbol) : false;
  } catch {
    return false;
  }
}

/**
 * Resolve the type symbol of a receiver expression, falling back through
 * the direct symbol, the constructor-signature return type, and the alias
 * symbol. Needed because class-instance types sometimes lack a direct symbol.
 */
function resolveTypeSymbol(
  receiver: ts.Expression,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  const receiverType = checker.getTypeAtLocation(receiver);

  const direct = receiverType.getSymbol();
  if (direct) return direct;

  // Fall back to the symbol returned from the constructor signature — this
  // handles class instance types that don't have a symbol attached directly.
  const constructorProp = receiverType
    .getProperties()
    .find(p => p.getName() === "constructor");
  if (constructorProp) {
    const signatures = checker
      .getTypeOfSymbolAtLocation(constructorProp, receiver)
      .getCallSignatures();
    if (signatures.length > 0) {
      const fromCtor = signatures[0].getReturnType().getSymbol();
      if (fromCtor) return fromCtor;
    }
  }

  return receiverType.aliasSymbol;
}

// ---------------------------------------------------------------------------
// Member path resolution (supports multiple param names for join predicates)
// ---------------------------------------------------------------------------

export interface ResolvedMember {
  param: string;
  path: string[];
}

/**
 * Walk a property access chain and return { param, path }.
 * Supports multiple param names (e.g. ["u", "posts"]) so
 * `(u, posts) => u.id === posts.authorId` works.
 */
export function resolveMemberPath(
  expr: ts.PropertyAccessExpression,
  paramNames: string[]
): ResolvedMember | null {
  const parts: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current) && paramNames.includes(current.text)) {
    return { param: current.text, path: parts };
  }
  return null;
}

/** Single-param convenience wrapper returning just the path. */
export function memberPath(
  expr: ts.PropertyAccessExpression,
  paramName: string
): string[] | null {
  const result = resolveMemberPath(expr, [paramName]);
  return result ? result.path : null;
}

// ---------------------------------------------------------------------------
// Small TS AST helpers
// ---------------------------------------------------------------------------

/** Unwrap a possibly-parenthesized expression and return it if it's an object literal. */
export function unwrapObjectLiteral(
  expr: ts.Expression
): ts.ObjectLiteralExpression | null {
  const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  return ts.isObjectLiteralExpression(inner) ? inner : null;
}

/** True if `node` is an Identifier with the given text. */
export function isIdentifierNamed(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

/**
 * Extract the single expression from an arrow or function body.
 * - Expression bodies are returned directly.
 * - Block bodies are returned only when they contain a single `return <expr>;`.
 * - Other shapes return null (caller should bail / fall back to runtime).
 */
export function getArrowExpressionBody(
  fn: ts.ArrowFunction | ts.FunctionExpression
): ts.Expression | null {
  if (!ts.isBlock(fn.body)) return fn.body;
  if (fn.body.statements.length !== 1) return null;
  const st = fn.body.statements[0];
  if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
  return st.expression;
}

/**
 * Validate a call expression matches `.<method>(arrow, ...)` on a Typhex
 * receiver and return the first arrow/function argument. Returns null for
 * any shape that shouldn't be transformed.
 *
 * `isTyphex` is passed in explicitly so callers can preserve import-level
 * mockability of `isTyphexType` (vitest module mocks don't intercept
 * intra-module calls).
 */
export function matchTyphexMethodCall(
  call: ts.CallExpression,
  methodName: string,
  checker: ts.TypeChecker,
  isTyphex: (receiver: ts.Expression, checker: ts.TypeChecker) => boolean
): ts.ArrowFunction | ts.FunctionExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (expr.name.text !== methodName) return null;
  if (!isTyphex(expr.expression, checker)) return null;

  const first = call.arguments[0];
  if (!first) return null;
  if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;
  return first;
}

// ---------------------------------------------------------------------------
// TS SyntaxKind → IR binary op
// ---------------------------------------------------------------------------

const BINARY_OP_MAP: Record<number, IrBinary["op"] | "in" | undefined> = {
  [ts.SyntaxKind.AmpersandAmpersandToken]:      "&&",
  [ts.SyntaxKind.BarBarToken]:                  "||",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]:      "===",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]:            "==",
  [ts.SyntaxKind.ExclamationEqualsToken]:       "!=",
  [ts.SyntaxKind.GreaterThanToken]:             ">",
  [ts.SyntaxKind.GreaterThanEqualsToken]:       ">=",
  [ts.SyntaxKind.LessThanToken]:                "<",
  [ts.SyntaxKind.LessThanEqualsToken]:          "<=",
  [ts.SyntaxKind.InKeyword]:                    "in",
};

/** Map a TS binary-operator SyntaxKind to its IR operator string (or null if unsupported). */
export function binaryOpFromSyntaxKind(
  kind: ts.SyntaxKind
): IrBinary["op"] | "in" | null {
  return BINARY_OP_MAP[kind] ?? null;
}

// ---------------------------------------------------------------------------
// Aggregate call detection & parsing (shared between where + select)
// ---------------------------------------------------------------------------

export const AGGREGATE_FUNCS = new Set([
  "SUM", "AVG", "MIN", "MAX", "COUNT",
  "GROUP_CONCAT", "STRING_AGG", "ARRAY_AGG", "JSON_AGG",
]);

const AGGREGATE_FUNC_MAP: Record<string, string> = {
  groupconcat: "GROUP_CONCAT",
  stringagg:   "STRING_AGG",
  arrayagg:    "ARRAY_AGG",
  jsonagg:     "JSON_AGG",
};

/** Map the JS stub identifier to the canonical IR func name. */
export function toIrFuncName(rawName: string): string {
  return AGGREGATE_FUNC_MAP[rawName.toLowerCase()] ?? rawName.toUpperCase();
}

export interface TsAggregateParseResult {
  /** Aggregate IR without an alias assigned — caller decides the alias. */
  ir: IrAggregate;
  /** Original identifier text, e.g. "count", "groupConcat". */
  rawName: string;
}

/**
 * Try to parse a TS CallExpression as an aggregate call (SUM, COUNT,
 * groupConcat, …). Returns null if the callee isn't an aggregate identifier.
 *
 * `paramNames` is the set of lambda parameter names in scope — it's plural
 * because the where transformer supports multi-param join predicates.
 */
export function parseTsAggregateCall(
  call: ts.CallExpression,
  paramNames: string[]
): TsAggregateParseResult | null {
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) return null;

  const rawName = callee.text;
  const funcName = toIrFuncName(rawName);
  if (!AGGREGATE_FUNCS.has(funcName)) return null;

  const { arg, distinct } = parseTsAggregateArg(
    call.arguments[0] as ts.Expression | undefined,
    paramNames
  );
  const separator = parseTsAggregateSeparator(funcName, call);

  const ir: IrAggregate = {
    kind: "aggregate",
    func: funcName as IrAggregate["func"],
    arg,
    ...(distinct ? { distinct: true } : {}),
    ...(separator === undefined ? {} : { separator }),
  };
  return { ir, rawName };
}

/**
 * Parse an aggregate's first argument: either a `distinct(field)` wrapper
 * or a plain `p.field` property access. Returns null arg/false distinct for
 * any other shape.
 */
function parseTsAggregateArg(
  argExpr: ts.Expression | undefined,
  paramNames: string[]
): { arg: IrNode | null; distinct: boolean } {
  if (!argExpr) return { arg: null, distinct: false };

  // distinct(field) wrapper — e.g. count(distinct(p.id))
  if (ts.isCallExpression(argExpr) && isIdentifierNamed(argExpr.expression, "distinct")) {
    return parseDistinctWrapperArg(argExpr, paramNames);
  }

  if (ts.isPropertyAccessExpression(argExpr)) {
    const resolved = resolveMemberPath(argExpr, paramNames);
    if (!resolved || resolved.path.length === 0) return { arg: null, distinct: false };
    return {
      arg: { kind: "member", param: resolved.param, path: resolved.path },
      distinct: false,
    };
  }

  return { arg: null, distinct: false };
}

/** Extract the member path from `distinct(p.field)` — only bare property access is allowed. */
function parseDistinctWrapperArg(
  distinctCall: ts.CallExpression,
  paramNames: string[]
): { arg: IrNode | null; distinct: boolean } {
  const inner = distinctCall.arguments[0] as ts.Expression | undefined;
  if (!inner || !ts.isPropertyAccessExpression(inner)) {
    return { arg: null, distinct: false };
  }
  const resolved = resolveMemberPath(inner, paramNames);
  if (!resolved || resolved.path.length === 0) return { arg: null, distinct: false };
  return {
    arg: { kind: "member", param: resolved.param, path: resolved.path },
    distinct: true,
  };
}

/**
 * Extract the string-literal separator argument of `GROUP_CONCAT` /
 * `STRING_AGG`; returns undefined for other aggregates or missing separators.
 */
function parseTsAggregateSeparator(
  funcName: string,
  call: ts.CallExpression
): string | undefined {
  if (funcName !== "GROUP_CONCAT" && funcName !== "STRING_AGG") return undefined;
  const sepExpr = call.arguments[1] as ts.Expression | undefined;
  return sepExpr && ts.isStringLiteral(sepExpr) ? sepExpr.text : undefined;
}

// ---------------------------------------------------------------------------
// IR → ts.ObjectLiteralExpression (used by both where and select transformers)
// ---------------------------------------------------------------------------

/** Convert a plain JS value into its equivalent TS literal expression node. */
function valueToTsExpression(value: unknown, f: ts.NodeFactory): ts.Expression {
  if (value === null) return f.createNull();
  switch (typeof value) {
    case "string":  return f.createStringLiteral(value);
    case "number":  return f.createNumericLiteral(value);
    case "boolean": return value ? f.createTrue() : f.createFalse();
  }
  if (Array.isArray(value)) {
    return f.createArrayLiteralExpression(
      (value as unknown[]).map(v => valueToTsExpression(v, f))
    );
  }
  // JSON.stringify returns undefined at runtime for undefined/functions/symbols
  return f.createStringLiteral(JSON.stringify(value) ?? String(value));
}

/** Build a `["a", "b", "c"]` array-literal node from a JS string array. */
function stringArrayLiteral(items: string[], f: ts.NodeFactory): ts.ArrayLiteralExpression {
  return f.createArrayLiteralExpression(items.map(p => f.createStringLiteral(p)));
}

/**
 * Serialize an IR node into a TS object-literal expression so the transformer
 * can emit it as the argument of the rewritten call. Recurses through binary,
 * unary, member, call, exists, in, and aggregate IR shapes.
 */
export function irNodeToTsLiteral(ir: IrNode): ts.ObjectLiteralExpression {
  const f = ts.factory;

  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("kind", f.createStringLiteral(ir.kind)),
  ];

  switch (ir.kind) {
    case "aggregate":
      return irAggregateToTsLiteral(ir);
    case "binary":
      props.push(
        f.createPropertyAssignment("op",    f.createStringLiteral(ir.op)),
        f.createPropertyAssignment("left",  irNodeToTsLiteral(ir.left)),
        f.createPropertyAssignment("right", irNodeToTsLiteral(ir.right)),
      );
      break;
    case "unary":
      props.push(
        f.createPropertyAssignment("op",      f.createStringLiteral(ir.op)),
        f.createPropertyAssignment("operand", irNodeToTsLiteral(ir.operand)),
      );
      break;
    case "member":
      props.push(
        f.createPropertyAssignment("param", f.createStringLiteral(ir.param)),
        f.createPropertyAssignment("path",  stringArrayLiteral(ir.path, f)),
      );
      break;
    case "const":
      props.push(f.createPropertyAssignment("value", valueToTsExpression(ir.value, f)));
      break;
    case "param":
      props.push(f.createPropertyAssignment("key", f.createStringLiteral(ir.key)));
      break;
    case "in":
      props.push(
        f.createPropertyAssignment("left",  irNodeToTsLiteral(ir.left)),
        f.createPropertyAssignment("right", irNodeToTsLiteral(ir.right)),
      );
      break;
    case "call":
      props.push(
        f.createPropertyAssignment("method",   f.createStringLiteral(ir.method)),
        f.createPropertyAssignment("receiver", irNodeToTsLiteral(ir.receiver)),
        f.createPropertyAssignment("args",
          f.createArrayLiteralExpression(ir.args.map(a => irNodeToTsLiteral(a)))
        ),
      );
      break;
    case "exists":
      props.push(
        f.createPropertyAssignment("rootParam",   f.createStringLiteral(ir.rootParam)),
        f.createPropertyAssignment("relationKey", f.createStringLiteral(ir.relationKey)),
        f.createPropertyAssignment("innerParam",  f.createStringLiteral(ir.innerParam)),
        f.createPropertyAssignment("innerWhere",  irNodeToTsLiteral(ir.innerWhere)),
      );
      break;
  }
  return f.createObjectLiteralExpression(props);
}

/** Serialize an IrOrderBy entry into a TS object literal. */
export function irOrderByToTsLiteral(ir: IrOrderBy): ts.ObjectLiteralExpression {
  const f = ts.factory;
  return f.createObjectLiteralExpression([
    f.createPropertyAssignment("param",     f.createStringLiteral(ir.param)),
    f.createPropertyAssignment("path",      stringArrayLiteral(ir.path, f)),
    f.createPropertyAssignment("direction", f.createStringLiteral(ir.direction)),
  ]);
}

/** Serialize an IrAggregate into a TS object literal, including optional alias/distinct/separator. */
export function irAggregateToTsLiteral(agg: IrAggregate): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("kind", f.createStringLiteral("aggregate")),
    f.createPropertyAssignment("func", f.createStringLiteral(agg.func)),
    f.createPropertyAssignment("arg",  agg.arg ? irNodeToTsLiteral(agg.arg) : f.createNull()),
  ];
  if (agg.alias)                 props.push(f.createPropertyAssignment("alias",     f.createStringLiteral(agg.alias)));
  if (agg.distinct)              props.push(f.createPropertyAssignment("distinct",  f.createTrue()));
  if (agg.separator !== undefined) props.push(f.createPropertyAssignment("separator", f.createStringLiteral(agg.separator)));
  return f.createObjectLiteralExpression(props);
}

/** Serialize an IrSelect into a TS object literal, emitting only populated optional fields. */
export function irSelectToTsLiteral(sel: IrSelect): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("param", f.createStringLiteral(sel.param)),
    f.createPropertyAssignment("paths",
      f.createArrayLiteralExpression(
        sel.paths.map(path => stringArrayLiteral(path, f))
      )
    ),
  ];

  if (sel.aliases && sel.aliases.length > 0) {
    props.push(f.createPropertyAssignment("aliases", stringArrayLiteral(sel.aliases, f)));
  }
  if (sel.rest) {
    props.push(f.createPropertyAssignment("rest", f.createTrue()));
  }
  if (sel.aggregates && sel.aggregates.length > 0) {
    props.push(f.createPropertyAssignment("aggregates",
      f.createArrayLiteralExpression(sel.aggregates.map(irAggregateToTsLiteral))
    ));
  }
  if (sel.groupBy && sel.groupBy.length > 0) {
    props.push(f.createPropertyAssignment("groupBy", groupByToTsLiteral(sel.groupBy, f)));
  }
  return f.createObjectLiteralExpression(props);
}

/** Serialize a groupBy entry list — numbers are positional, arrays are member paths. */
function groupByToTsLiteral(
  groupBy: Array<string[] | number>,
  f: ts.NodeFactory
): ts.ArrayLiteralExpression {
  return f.createArrayLiteralExpression(
    groupBy.map(entry =>
      typeof entry === "number"
        ? f.createNumericLiteral(entry)
        : stringArrayLiteral(entry, f)
    )
  );
}
