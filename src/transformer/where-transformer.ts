/**
 * Transformer for .where() / .having() calls: converts arrow predicates to IR.
 */

import * as ts from "typescript";
import type {
  IrNode,
  IrExists,
  IrCall,
  IrBinary,
  IrIn,
  IrConst,
  IrSubqueryRef,
  IrWhere,
  IrCase,
} from "../ir/types.js";
import {
  buildParamsLiteral,
  captureSubqueryRef as captureSubqueryRefShared,
  isTyphexQueryChain,
  type CapturedSubquery,
} from "./subquery-transformer.js";
import {
  getArrowExpressionBody,
  isTyphexType,
  matchTyphexMethodCall,
  resolveMemberPath,
  binaryOpFromSyntaxKind,
  parseTsAggregateCall,
  irWhereToTsLiteral,
  getParamBindings,
  type ParamBindings,
  type ScopeFrame,
} from "./shared.js";
import { ALLOWED_METHODS } from "../arrow/constants.js";

/** Destructured outer-arrow context. When the surrounding `.select(({ id }) => …)`
 *  arrow uses object destructuring, the inner subquery's WHERE may reference
 *  the destructured locals (e.g. `id`) — these resolve to IrMember on the
 *  outer row rather than free variables. Always carries non-null bindings;
 *  when the outer arrow has no destructure, callers pass `undefined` instead. */
export type OuterDestructured = ParamBindings & { bindings: Map<string, string[]> };

/** Narrow a ParamBindings into an OuterDestructured (or undefined when there
 *  are no destructured locals to expose). Centralizes the conversion. */
export function toOuterDestructured(pb: ParamBindings): OuterDestructured | undefined {
  return pb.bindings ? { ...pb, bindings: pb.bindings } : undefined;
}

/** Context bundle threaded through where-IR conversion: lambda param names,
 *  free-var collector, type checker, and the optional outer-destructured info. */
interface WhereCtx {
  paramNames: string[];
  freeVars: Set<string>;
  capturedSubqueries: CapturedSubquery[];
  checker?: ts.TypeChecker;
  outerDestructured?: OuterDestructured;
  /** Stack of enclosing arrow ScopeFrames (paramName + optional destructured
   *  bindings). Identifiers matching any frame's paramName or bindings resolve
   *  as `IrMember` against the named outer row (correlated reference) rather
   *  than as closure captures. */
  outerScope?: ScopeFrame[];
}

// ---------------------------------------------------------------------------
// Expression → IR dispatch
// ---------------------------------------------------------------------------

/**
 * Convert a TS expression to IR. Returns null for unsupported expressions;
 * the transformer silently skips them and the runtime parser can handle them
 * later if needed.
 */
function exprToIr(expr: ts.Expression, ctx: WhereCtx): IrNode | null {
  if (ts.isParenthesizedExpression(expr)) return exprToIr(expr.expression, ctx);
  if (ts.isBinaryExpression(expr)) return binaryExprToIr(expr, ctx);
  if (isPrefixUnaryExpression(expr)) return prefixUnaryExprToIr(expr, ctx);
  if (ts.isPropertyAccessExpression(expr)) return memberExprToIr(expr, ctx);
  if (ts.isIdentifier(expr)) return identifierToIr(expr, ctx);
  if (isConstantLiteral(expr)) return literalToIr(expr);
  if (ts.isCallExpression(expr)) return callExprToIr(expr, ctx);
  if (ts.isArrayLiteralExpression(expr)) return arrayLiteralToIr(expr, ctx);
  if (ts.isConditionalExpression(expr)) return conditionalExprToIr(expr, ctx);
  return null;
}

// ---- Node kind predicates ---------------------------------------------------

/** Narrowing predicate: is this a `!expr` / `~expr` prefix unary expression? */
function isPrefixUnaryExpression(expr: ts.Expression): expr is ts.PrefixUnaryExpression {
  return (
    ts.isPrefixUnaryExpression(expr) &&
    (expr.operator === ts.SyntaxKind.ExclamationToken ||
      expr.operator === ts.SyntaxKind.TildeToken)
  );
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
function binaryExprToIr(expr: ts.BinaryExpression, ctx: WhereCtx): IrNode | null {
  const opStr = binaryOpFromSyntaxKind(expr.operatorToken.kind);
  if (!opStr) return null;

  if (opStr === "in" && ctx.checker) {
    const left = exprToIr(expr.left, ctx);
    if (!left) return null;
    // Pass paramNames so the inline subquery's inner where can reference
    // the outer arrow's row params (correlated IN subquery).
    const sub = isTyphexQueryChain(expr.right, ctx.checker);
    if (sub) return { kind: "in", left, right: captureSubqueryRef(expr.right, ctx) } as IrIn;
    const right = exprToIr(expr.right, ctx);
    if (!right) return null;
    return { kind: "in", left, right } as IrIn;
  }

  const left = exprToIr(expr.left, ctx) ?? tryExtractSubqueryRef(expr.left, ctx);
  const right = exprToIr(expr.right, ctx) ?? tryExtractSubqueryRef(expr.right, ctx);
  if (!left || !right) return null;

  if (opStr === "in") return { kind: "in", left, right } as IrIn;
  return { kind: "binary", op: opStr, left, right } as IrBinary;
}

function tryExtractSubqueryRef(expr: ts.Expression, ctx: WhereCtx): IrSubqueryRef | null {
  if (!ctx.checker) return null;
  const sub = isTyphexQueryChain(expr, ctx.checker);
  return sub ? captureSubqueryRef(expr, ctx) : null;
}

function captureSubqueryRef(expr: ts.Expression, ctx: WhereCtx): IrSubqueryRef {
  return captureSubqueryRefShared(expr, ctx.capturedSubqueries);
}

/** Handle `!<expr>` / `~<expr>` — `!` wraps inner IR; `~` emits bitwise NOT. */
function prefixUnaryExprToIr(expr: ts.PrefixUnaryExpression, ctx: WhereCtx): IrNode | null {
  const operand = exprToIr(expr.operand, ctx);
  if (!operand) return null;
  const op = expr.operator === ts.SyntaxKind.TildeToken ? "~" : "!";
  if (op === "!" && operand.kind === "in") return { ...operand, negated: !operand.negated };
  return { kind: "unary", op, operand };
}

/** Handle `p.a.b.c` — resolves against the lambda params and returns an IrMember.
 *  Falls back to `outerDestructured` so `post.id` works when `post` is a
 *  destructured local from the outer arrow, then to `outerScope` so a bare
 *  outer-arrow param `u` in `u.id` resolves as IrMember on `u`. */
function memberExprToIr(expr: ts.PropertyAccessExpression, ctx: WhereCtx): IrNode | null {
  const resolved = resolveMemberPath(expr, ctx.paramNames);
  if (resolved) return { kind: "member", param: resolved.param, path: resolved.path };

  // Walk the chain manually so we can resolve the root identifier against
  // outerDestructured / outerScope.
  const parts: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;

  if (ctx.outerDestructured) {
    const prefix = ctx.outerDestructured.bindings.get(current.text);
    if (prefix)
      return {
        kind: "member",
        param: ctx.outerDestructured.paramName,
        path: [...prefix, ...parts],
      };
  }

  if (ctx.outerScope) {
    for (const frame of ctx.outerScope) {
      if (frame.paramName === current.text) {
        return { kind: "member", param: current.text, path: parts };
      }
      const bound = frame.bindings?.get(current.text);
      if (bound) {
        return { kind: "member", param: frame.paramName, path: [...bound, ...parts] };
      }
    }
  }
  return null;
}

/**
 * Handle a bare identifier — either a lambda parameter (→ IrMember with
 * empty path) or a closure variable (→ IrParam; the caller records it in
 * `freeVars` so the rewritten call can pass it along at runtime).
 */
function identifierToIr(expr: ts.Identifier, ctx: WhereCtx): IrNode {
  if (ctx.paramNames.includes(expr.text)) {
    return { kind: "member", param: expr.text, path: [] };
  }
  if (ctx.outerDestructured) {
    const path = ctx.outerDestructured.bindings.get(expr.text);
    if (path) return { kind: "member", param: ctx.outerDestructured.paramName, path };
  }
  if (ctx.outerScope) {
    for (const frame of ctx.outerScope) {
      if (frame.paramName === expr.text) {
        return { kind: "member", param: expr.text, path: [] };
      }
      const bound = frame.bindings?.get(expr.text);
      if (bound) {
        return { kind: "member", param: frame.paramName, path: bound };
      }
    }
  }
  ctx.freeVars.add(expr.text);
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
function arrayLiteralToIr(expr: ts.ArrayLiteralExpression, ctx: WhereCtx): IrNode | null {
  const values: unknown[] = [];
  for (const element of expr.elements) {
    if (element.kind === ts.SyntaxKind.SpreadElement) return null;
    const ir = exprToIr(element, ctx);
    if (!ir || ir.kind !== "const") return null;
    values.push(ir.value);
  }
  return { kind: "const", value: values };
}

/** Handle `test ? consequent : alternate` — flattens nested ternaries in the alternate branch. */
function conditionalExprToIr(expr: ts.ConditionalExpression, ctx: WhereCtx): IrCase | null {
  const when = exprToIr(expr.condition, ctx);
  const then = exprToIr(expr.whenTrue, ctx);
  const alternate = exprToIr(expr.whenFalse, ctx);
  if (!when || !then || !alternate) return null;

  if (alternate.kind === "case") {
    return {
      kind: "case",
      branches: [{ when, then }, ...alternate.branches],
      ...(alternate.else !== undefined ? { else: alternate.else } : {}),
    };
  }
  return { kind: "case", branches: [{ when, then }], else: alternate };
}

// ---- CallExpression handling -----------------------------------------------

/**
 * Dispatch a CallExpression: method calls go through some/every or the
 * string-method whitelist; identifier calls must be aggregate functions.
 */
function callExprToIr(expr: ts.CallExpression, ctx: WhereCtx): IrNode | null {
  const callee = expr.expression;

  // Method calls: .some()/.every()/.startsWith()/.endsWith()/.includes()
  if (ts.isPropertyAccessExpression(callee)) {
    // some/every introduce their own inner-row scope; outer destructured locals
    // do not leak into that scope (matches the existing freeVars isolation).
    const exists = tryParseSomeEvery(expr, callee, ctx);
    if (exists) return exists;

    return tryParseAllowedMethod(expr, callee, ctx);
  }

  // Identifier calls: aggregates only — SUM, COUNT, groupConcat, etc.
  if (ts.isIdentifier(callee)) {
    const parsed = parseTsAggregateCall(expr, ctx.paramNames);
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
  ctx: WhereCtx,
): IrCall | null {
  const method = callee.name.text;
  if (!ALLOWED_METHODS.has(method)) return null;

  const receiver = exprToIr(callee.expression, ctx);
  if (!receiver) return null;

  const args = call.arguments.map((a) => exprToIr(a, ctx));
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
  ctx: WhereCtx,
): IrExists | null {
  const method = callee.name.text;
  if (method !== "some" && method !== "every") return null;
  if (call.arguments.length !== 1) return null;
  if (!ts.isPropertyAccessExpression(callee.expression)) return null;

  const receiver = resolveMemberPath(callee.expression, ctx.paramNames);
  if (!receiver || receiver.path.length < 1) return null;

  const innerFn = call.arguments[0];
  if (!ts.isArrowFunction(innerFn) && !ts.isFunctionExpression(innerFn)) return null;

  const innerParam = getFirstParamName(innerFn) ?? "e";
  const innerExpr = getArrowExpressionBody(innerFn);
  if (!innerExpr) return null;

  // Inner free-vars are intentionally discarded — subquery scope is self-contained.
  const innerWhere = exprToIr(innerExpr, {
    paramNames: [innerParam],
    freeVars: new Set(),
    capturedSubqueries: [],
    checker: ctx.checker,
  });
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
  checker: ts.TypeChecker,
  extraParamNames: string[] = [],
  outerDestructured?: OuterDestructured,
  outerScope?: ScopeFrame[],
): { ir: IrWhere; freeVars: string[]; capturedSubqueries: CapturedSubquery[] } | null {
  const expr = getArrowExpressionBody(fn);
  if (!expr) return null;

  const paramNames = [...extractParamNames(fn), ...extraParamNames];
  const freeVars = new Set<string>();
  const capturedSubqueries: CapturedSubquery[] = [];

  const ir = exprToIr(expr, {
    paramNames,
    freeVars,
    capturedSubqueries,
    checker,
    outerDestructured,
    outerScope,
  });
  if (!ir) return null;

  return {
    ir: {
      node: ir,
      rootParam: paramNames[0] ?? "u",
      localParamNames: paramNames,
    },
    freeVars: [...freeVars],
    capturedSubqueries,
  };
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
  outerScope: ScopeFrame[] = [],
): ts.CallExpression | null {
  const arrow = matchTyphexMethodCall(call, methodName, checker, isTyphexType);
  if (!arrow) return null;

  // If the where/having arrow's first param is destructured, expose its
  // bindings so a bare local (or member access on a destructured local)
  // inside an inline subquery's correlated WHERE resolves to the outer row.
  const pb = getParamBindings(arrow.parameters[0]?.name);
  const result = arrowToIr(arrow, checker, [], toOuterDestructured(pb), outerScope);
  if (!result) return null;

  const args: ts.Expression[] = [
    irWhereToTsLiteral(result.ir),
    buildParamsLiteral(result.freeVars, result.capturedSubqueries),
  ];
  return ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args);
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Convert a where-style arrow (`p => predicate`) to IR + free-var list.
 *  Exposed for the select transformer so it can parse inner WHEREs of
 *  inline subqueries used as scalar columns. `outerParamNames` enables
 *  correlation: bare references to those names resolve as IrMember rather
 *  than as free variables. */
export function parseWhereArrowToIr(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  outerParamNames: string[] = [],
  outerDestructured?: OuterDestructured,
  outerScope?: ScopeFrame[],
): { ir: IrWhere; freeVars: string[] } | null {
  return arrowToIr(fn, checker, outerParamNames, outerDestructured, outerScope);
}

/** Convert a single TS expression to IR for select/orderBy transformers. */
export function parseExpressionToIr(
  expr: ts.Expression,
  paramNames: string[],
  freeVars: Set<string>,
  checker?: ts.TypeChecker,
): IrNode | null {
  return exprToIr(expr, {
    paramNames,
    freeVars,
    capturedSubqueries: [],
    checker,
  });
}

/** Rewrite a `.where(arrow)` call on a Typhex Table/QueryBuilder into IR form. */
export function transformWhereCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  outerScope: ScopeFrame[] = [],
): ts.CallExpression | null {
  return transformArrowCall(call, checker, "where", outerScope);
}

/** Rewrite a `.having(arrow)` call on a Typhex Table/QueryBuilder into IR form. */
export function transformHavingCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  outerScope: ScopeFrame[] = [],
): ts.CallExpression | null {
  return transformArrowCall(call, checker, "having", outerScope);
}
