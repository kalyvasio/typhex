/**
 * Transformer for .select() calls: converts object-literal arrows to IrSelect.
 */

import * as ts from "typescript";
import type { IrSelect, IrAggregate, IrSubqueryRef, IrNode } from "../ir/types.js";
import {
  isTyphexType,
  matchTyphexMethodCall,
  memberPath,
  unwrapObjectLiteral,
  parseTsAggregateCall,
  irSelectToTsLiteral,
  irAggregateToTsLiteral,
  getParamBindings,
  type ParamBindings,
} from "./shared.js";
import { parseExprToIr } from "./where-transformer.js";
import {
  buildParamsLiteral,
  captureSubqueryRef,
  isTyphexQueryChain,
  type CapturedSubquery,
} from "./subquery-transformer.js";

// ---------------------------------------------------------------------------
// Top-level arrow dispatch
// ---------------------------------------------------------------------------

/**
 * Convert a `.select(arrow)` arrow into an IrSelect. Handles the shorthand
 * bodies (`p => p`, `p => p.col`, `p => count(p.id)`) as well as object-
 * literal bodies. Returns null for shapes that don't map cleanly.
 */
function arrowToIrSelect(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  pb: ParamBindings,
  checker: ts.TypeChecker,
  capturedSubqueries: CapturedSubquery[],
  freeVars: Set<string>,
): IrSelect | null {
  if (!ts.isBlock(fn.body)) {
    const shorthand = tryParseShorthandBody(fn.body, pb.paramName, freeVars);
    if (shorthand) return shorthand;
  }

  const obj = extractReturnedObjectLiteral(fn);
  if (!obj) return null;
  return parseSelectObjectLiteral(obj, pb, checker, capturedSubqueries, freeVars);
}

/**
 * Return the object literal produced by an arrow body — either directly
 * (expression body) or via a single `return { ... }` statement in a block.
 */
function extractReturnedObjectLiteral(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): ts.ObjectLiteralExpression | null {
  if (!ts.isBlock(fn.body)) return unwrapObjectLiteral(fn.body);

  if (fn.body.statements.length !== 1) return null;
  const st = fn.body.statements[0];
  if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
  return unwrapObjectLiteral(st.expression);
}

// ---- Shorthand bodies -------------------------------------------------------

/** Dispatch the single-expression shorthand body shapes to their handlers. */
function tryParseShorthandBody(
  body: ts.ConciseBody,
  paramName: string,
  freeVars: Set<string>,
): IrSelect | null {
  if (ts.isIdentifier(body) && body.text === paramName) {
    return { param: paramName, paths: [], aliases: [], rest: true };
  }

  if (ts.isPropertyAccessExpression(body)) {
    return parseShorthandMemberBody(body, paramName);
  }

  if (ts.isCallExpression(body)) {
    return parseShorthandAggregateBody(body, paramName, freeVars);
  }

  if (!ts.isExpression(body)) return null;
  return parseShorthandExpressionBody(body, paramName, freeVars);
}

/** Handle `p => p.id` / `p => p.author.name` — emits a single-column IrSelect aliased to the leaf name. */
function parseShorthandMemberBody(
  body: ts.PropertyAccessExpression,
  paramName: string,
): IrSelect | null {
  const path = memberPath(body, paramName);
  if (!path || path.length === 0) return null;
  const alias = path[path.length - 1];
  return { param: paramName, paths: [path], aliases: [alias] };
}

/** Handle `p => count(p.id)` — single aggregate aliased to the lowercased function name. */
function parseShorthandAggregateBody(
  body: ts.CallExpression,
  paramName: string,
  freeVars: Set<string>,
): IrSelect | null {
  const resolveArg = (expr: ts.Expression) => parseExprToIr(expr, [paramName], freeVars);
  const parsed = parseTsAggregateCall(body, [paramName], resolveArg);
  if (!parsed) return null;
  const alias = parsed.rawName.toLowerCase();
  return {
    param: paramName,
    paths: [],
    aliases: [],
    aggregates: [{ ...parsed.ir, alias }],
  };
}

function parseShorthandExpressionBody(
  body: ts.Expression,
  paramName: string,
  freeVars: Set<string>,
): IrSelect | null {
  const ir = parseExprToIr(body, [paramName], freeVars);
  if (!ir || ir.kind === "member" || ir.kind === "param") return null;
  return {
    param: paramName,
    paths: [],
    aliases: [],
    expressions: [{ expr: ir, alias: "expr" }],
  };
}

// ---- Object literal body ---------------------------------------------------

/**
 * Walk each property of a `{ ... }` select body and accumulate the column
 * paths, aliases, aggregates, and spread flag into an IrSelect. Returns
 * null if any property fails to map.
 */
function parseSelectObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  pb: ParamBindings,
  checker: ts.TypeChecker,
  capturedSubqueries: CapturedSubquery[],
  freeVars: Set<string>,
): IrSelect | null {
  const paths: string[][] = [];
  const aliases: string[] = [];
  const aggregates: IrAggregate[] = [];
  const subqueries: Array<{ alias: string; subquery: IrSubqueryRef }> = [];
  const expressions: Array<{ expr: IrNode; alias: string }> = [];
  let rest = false;

  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (!isRestSpread(prop, pb)) return null;
      rest = true;
      continue;
    }

    const keyName = getPropertyKeyName(prop);
    if (!keyName) return null;

    const handled = parseSelectObjectProperty(prop, keyName, pb, checker, capturedSubqueries, freeVars);
    if (!handled) return null;

    switch (handled.kind) {
      case "path":
        paths.push(handled.path);
        aliases.push(keyName);
        break;
      case "aggregate":
        aggregates.push(handled.aggregate);
        break;
      case "subquery":
        subqueries.push({ alias: keyName, subquery: handled.subquery });
        break;
      case "expression":
        expressions.push({ expr: handled.expr, alias: keyName });
        break;
    }
  }

  if (paths.length === 0 && aggregates.length === 0 && subqueries.length === 0 && expressions.length === 0 && !rest) {
    return null;
  }
  return {
    param: pb.paramName,
    paths,
    aliases,
    ...(rest ? { rest: true } : {}),
    ...(aggregates.length > 0 ? { aggregates } : {}),
    ...(subqueries.length > 0 ? { subqueries } : {}),
    ...(expressions.length > 0 ? { expressions } : {}),
  };
}

/** True if the spread refers to the whole row (or the ...rest binding of a destructured param). */
function isRestSpread(prop: ts.SpreadAssignment, pb: ParamBindings): boolean {
  if (!ts.isIdentifier(prop.expression)) return false;
  const name = prop.expression.text;
  return name === pb.restName || name === pb.paramName;
}

/** Return the property's key text — only plain identifier keys are supported. */
function getPropertyKeyName(prop: ts.ObjectLiteralElementLike): string | null {
  const name = prop.name;
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  return null; // computed / literal-string / etc. not supported
}

type PropertyResult =
  | { kind: "path"; path: string[] }
  | { kind: "aggregate"; aggregate: IrAggregate }
  | { kind: "subquery"; subquery: IrSubqueryRef }
  | { kind: "expression"; expr: IrNode };

function parseSelectObjectProperty(
  prop: ts.ObjectLiteralElementLike,
  keyName: string,
  pb: ParamBindings,
  checker: ts.TypeChecker,
  capturedSubqueries: CapturedSubquery[],
  freeVars: Set<string>,
): PropertyResult | null {
  if (ts.isShorthandPropertyAssignment(prop)) {
    const path = pb.bindings?.get(keyName);
    return path ? { kind: "path", path } : null;
  }

  if (!ts.isPropertyAssignment(prop)) return null;
  const value = prop.initializer;
  const resolveArg = (expr: ts.Expression) => parseExprToIr(expr, [pb.paramName], freeVars);

  if (ts.isPropertyAccessExpression(value)) {
    const path = memberPath(value, pb.paramName);
    if (!path || path.length === 0) return null;
    return { kind: "path", path };
  }

  if (pb.bindings && ts.isIdentifier(value)) {
    const path = pb.bindings.get(value.text);
    if (path) return { kind: "path", path };
  }

  if (ts.isCallExpression(value)) {
    const parsed = parseTsAggregateCall(value, [pb.paramName], resolveArg);
    if (parsed) return { kind: "aggregate", aggregate: { ...parsed.ir, alias: keyName } };

    if (isTyphexQueryChain(value, checker)) {
      return {
        kind: "subquery",
        subquery: captureSubqueryRef(value, capturedSubqueries),
      };
    }
  }

  const expr = parseExprToIr(value, [pb.paramName], freeVars);
  if (!expr || expr.kind === "member" || expr.kind === "param") return null;
  return { kind: "expression", expr };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Rewrite a `.select(arrow)` call on a Typhex Table/QueryBuilder into an IrSelect literal. */
export function transformSelectCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.CallExpression | null {
  const arrow = matchTyphexMethodCall(call, "select", checker, isTyphexType);
  if (!arrow) return null;

  const pb = getParamBindings(arrow.parameters[0]?.name);
  const capturedSubqueries: CapturedSubquery[] = [];
  const freeVars = new Set<string>();
  const irSelect = arrowToIrSelect(arrow, pb, checker, capturedSubqueries, freeVars);
  if (!irSelect) return null;

  const args: ts.Expression[] = [irSelectToTsLiteral(irSelect)];
  if (capturedSubqueries.length > 0 || freeVars.size > 0) {
    args.push(buildParamsLiteral([...freeVars], capturedSubqueries));
  }
  return ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args);
}

export { irAggregateToTsLiteral };
