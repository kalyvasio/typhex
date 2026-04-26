/**
 * Transformer for .where() / .having() calls: converts arrow predicates to IR.
 */

import * as ts from "typescript";
import type { IrNode, IrExists, IrCall, IrBinary, IrIn, IrConst } from "../ir/types.js";
import {
  getArrowExpressionBody,
  isTyphexType,
  matchTyphexMethodCall,
  resolveMemberPath,
  binaryOpFromSyntaxKind,
  parseTsAggregateCall,
  irNodeToTsLiteral,
} from "./shared.js";

const ALLOWED_METHODS = new Set(["startsWith", "endsWith", "includes"]);

// ---------------------------------------------------------------------------
// Expression → IR dispatch
// ---------------------------------------------------------------------------

/**
 * Convert a TS expression to IR. Returns null for unsupported expressions;
 * the transformer silently skips them and the runtime parser can handle them
 * later if needed.
 */
function exprToIr(expr: ts.Expression, paramNames: string[], freeVars: Set<string>): IrNode | null {
  if (ts.isParenthesizedExpression(expr)) {
    return exprToIr(expr.expression, paramNames, freeVars);
  }
  if (ts.isBinaryExpression(expr)) return binaryExprToIr(expr, paramNames, freeVars);
  if (isBangExpression(expr)) return unaryExprToIr(expr, paramNames, freeVars);
  if (ts.isPropertyAccessExpression(expr)) return memberExprToIr(expr, paramNames);
  if (ts.isIdentifier(expr)) return identifierToIr(expr, paramNames, freeVars);
  if (isConstantLiteral(expr)) return literalToIr(expr);
  if (ts.isCallExpression(expr)) return callExprToIr(expr, paramNames, freeVars);
  if (ts.isArrayLiteralExpression(expr)) return arrayLiteralToIr(expr, paramNames, freeVars);
  return null;
}

// ---- Node kind predicates ---------------------------------------------------

/** Narrowing predicate: is this a `!<expr>` prefix unary expression? */
function isBangExpression(expr: ts.Expression): expr is ts.PrefixUnaryExpression {
  return ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken;
}

/** True if the expression is a supported literal constant (string/number/bool/null). */
function isConstantLiteral(expr: ts.Expression): boolean {
  return (
    ts.isStringLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  );
}

// ---- Per-node-kind handlers -------------------------------------------------

/** Handle `&&`, `||`, `===`, `in`, etc. — returns IrBinary or IrIn. */
function binaryExprToIr(
  expr: ts.BinaryExpression,
  paramNames: string[],
  freeVars: Set<string>,
): IrNode | null {
  const opStr = binaryOpFromSyntaxKind(expr.operatorToken.kind);
  if (!opStr) return null;

  const left = exprToIr(expr.left, paramNames, freeVars);
  const right = exprToIr(expr.right, paramNames, freeVars);
  if (!left || !right) return null;

  if (opStr === "in") return { kind: "in", left, right } as IrIn;
  return { kind: "binary", op: opStr, left, right } as IrBinary;
}

/** Handle `!<expr>` — wraps the inner IR in an IrUnary with `!`. */
function unaryExprToIr(
  expr: ts.PrefixUnaryExpression,
  paramNames: string[],
  freeVars: Set<string>,
): IrNode | null {
  const operand = exprToIr(expr.operand, paramNames, freeVars);
  if (!operand) return null;
  return { kind: "unary", op: "!", operand };
}

/** Handle `p.a.b.c` — resolves against the lambda params and returns an IrMember. */
function memberExprToIr(expr: ts.PropertyAccessExpression, paramNames: string[]): IrNode | null {
  const resolved = resolveMemberPath(expr, paramNames);
  if (!resolved) return null;
  return { kind: "member", param: resolved.param, path: resolved.path };
}

/**
 * Handle a bare identifier — either a lambda parameter (→ IrMember with
 * empty path) or a closure variable (→ IrParam; the caller records it in
 * `freeVars` so the rewritten call can pass it along at runtime).
 */
function identifierToIr(expr: ts.Identifier, paramNames: string[], freeVars: Set<string>): IrNode {
  if (paramNames.includes(expr.text)) {
    return { kind: "member", param: expr.text, path: [] };
  }
  freeVars.add(expr.text);
  return { kind: "param", key: expr.text };
}

/** Handle a constant literal expression — wraps the extracted value in an IrConst. */
function literalToIr(expr: ts.Expression): IrConst {
  const value = extractLiteralValue(expr);
  return { kind: "const", value };
}

/** Convert a literal TS expression into its JS value (string/number/bool/null). */
function extractLiteralValue(expr: ts.Expression): unknown {
  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

/**
 * Handle `[a, b, c]` — only valid as the right-hand-side of `in`, so all
 * elements must reduce to constants. Returns null for spreads / non-literals.
 */
function arrayLiteralToIr(
  expr: ts.ArrayLiteralExpression,
  paramNames: string[],
  freeVars: Set<string>,
): IrNode | null {
  const values: unknown[] = [];
  for (const element of expr.elements) {
    if (element.kind === ts.SyntaxKind.SpreadElement) return null;
    const ir = exprToIr(element, paramNames, freeVars);
    if (!ir || ir.kind !== "const") return null;
    values.push(ir.value);
  }
  return { kind: "const", value: values };
}

// ---- CallExpression handling -----------------------------------------------

/**
 * Dispatch a CallExpression: method calls go through some/every or the
 * string-method whitelist; identifier calls must be aggregate functions.
 */
function callExprToIr(
  expr: ts.CallExpression,
  paramNames: string[],
  freeVars: Set<string>,
): IrNode | null {
  const callee = expr.expression;

  // Method calls: .some()/.every()/.startsWith()/.endsWith()/.includes()
  if (ts.isPropertyAccessExpression(callee)) {
    const exists = tryParseSomeEvery(expr, callee, paramNames, freeVars);
    if (exists) return exists;

    return tryParseAllowedMethod(expr, callee, paramNames, freeVars);
  }

  // Identifier calls: aggregates only — SUM, COUNT, groupConcat, etc.
  if (ts.isIdentifier(callee)) {
    const parsed = parseTsAggregateCall(expr, paramNames);
    return parsed ? parsed.ir : null;
  }

  return null;
}

/**
 * Parse `.startsWith(arg)`, `.endsWith(arg)`, or `.includes(arg)` — returns
 * an IrCall node, or null if the method isn't in the allowlist or an
 * argument fails to convert.
 */
function tryParseAllowedMethod(
  call: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
  paramNames: string[],
  freeVars: Set<string>,
): IrCall | null {
  const method = callee.name.text;
  if (!ALLOWED_METHODS.has(method)) return null;

  const receiver = exprToIr(callee.expression, paramNames, freeVars);
  if (!receiver) return null;

  const args = call.arguments.map((a) => exprToIr(a, paramNames, freeVars));
  if (args.some((a) => a === null)) return null;

  return { kind: "call", method, receiver, args: args as IrNode[] };
}

/**
 * Parse `relation.some(cb)` or `relation.every(cb)` into an IrExists subquery.
 * `.every` becomes a negated exists. Returns null for shapes that don't
 * match.
 */
function tryParseSomeEvery(
  call: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
  paramNames: string[],
  _freeVars: Set<string>,
): IrExists | null {
  const method = callee.name.text;
  if (method !== "some" && method !== "every") return null;
  if (call.arguments.length !== 1) return null;
  if (!ts.isPropertyAccessExpression(callee.expression)) return null;

  const receiver = resolveMemberPath(callee.expression, paramNames);
  if (!receiver || receiver.path.length < 1) return null;

  const innerFn = call.arguments[0];
  if (!ts.isArrowFunction(innerFn) && !ts.isFunctionExpression(innerFn)) return null;

  const innerParam = getFirstParamName(innerFn) ?? "e";
  const innerExpr = getArrowExpressionBody(innerFn);
  if (!innerExpr) return null;

  // Inner free-vars are intentionally discarded — subquery scope is self-contained.
  const innerWhere = exprToIr(innerExpr, [innerParam], new Set());
  if (!innerWhere) return null;

  return {
    kind: "exists",
    ...(method === "every" ? { negated: true } : {}),
    rootParam: receiver.param,
    relationKey: receiver.path[0],
    innerParam,
    innerWhere,
  };
}

/** Return the first parameter's name if it's a plain identifier; null otherwise. */
function getFirstParamName(fn: ts.ArrowFunction | ts.FunctionExpression): string | null {
  const param = fn.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return null;
  return param.text;
}

// ---------------------------------------------------------------------------
// Arrow → IR + free-variable collection
// ---------------------------------------------------------------------------

/** Extract the lambda parameter names as strings; defaults to "u" per slot. */
function extractParamNames(fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
  return fn.parameters.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : "u"));
}

/**
 * Convert a where/having arrow into its IR plus the list of closure
 * variables referenced by the predicate. Returns null if the body shape or
 * inner expressions can't be mapped onto the supported IR subset.
 */
function arrowToIr(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): { ir: IrNode; freeVars: string[] } | null {
  const expr = getArrowExpressionBody(fn);
  if (!expr) return null;

  const paramNames = extractParamNames(fn);
  const freeVars = new Set<string>();

  const ir = exprToIr(expr, paramNames, freeVars);
  if (!ir) return null;

  return { ir, freeVars: [...freeVars] };
}

// ---------------------------------------------------------------------------
// Transform orchestration — where() and having() share everything.
// ---------------------------------------------------------------------------

/**
 * Validate the call site, parse the arrow, and emit the rewritten call of
 * the form `table.<method>(irLiteral, freeVarsLiteral)`. Returns null when
 * the call shouldn't be rewritten.
 */
function transformArrowCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  methodName: string,
): ts.CallExpression | null {
  const arrow = matchTyphexMethodCall(call, methodName, checker, isTyphexType);
  if (!arrow) return null;

  const result = arrowToIr(arrow);
  if (!result) return null;

  return ts.factory.updateCallExpression(call, call.expression, call.typeArguments, [
    irNodeToTsLiteral(result.ir),
    buildFreeVarsLiteral(result.freeVars),
  ]);
}

/** Build the `{ foo, bar }` literal passed as the second argument of the rewritten call. */
function buildFreeVarsLiteral(freeVars: string[]): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props = freeVars.map((v) => f.createShorthandPropertyAssignment(f.createIdentifier(v)));
  return f.createObjectLiteralExpression(props);
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Rewrite a `.where(arrow)` call on a Typhex Table/QueryBuilder into IR form. */
export function transformWhereCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.CallExpression | null {
  return transformArrowCall(call, checker, "where");
}

/** Rewrite a `.having(arrow)` call on a Typhex Table/QueryBuilder into IR form. */
export function transformHavingCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.CallExpression | null {
  return transformArrowCall(call, checker, "having");
}
