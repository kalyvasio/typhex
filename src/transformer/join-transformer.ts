/**
 * Transformer for join calls (innerJoin, leftJoin, rightJoin, crossJoin,
 * fullJoin): converts relation lambdas into a string-array of relation keys.
 */

import * as ts from "typescript";
import { isTyphexType, memberPath, unwrapObjectLiteral } from "./shared.js";

const JOIN_METHOD_NAMES = new Set([
  "innerJoin", "leftJoin", "rightJoin", "crossJoin", "fullJoin",
]);

/**
 * Rewrite `innerJoin`/`leftJoin`/`rightJoin`/`crossJoin`/`fullJoin` calls into
 * a simple `[...relationKeys]` string-array argument. Returns null when the
 * call shape isn't recognized — falls back to runtime parsing.
 */
export function transformJoinCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const fn = matchJoinCall(call, checker);
  if (!fn) return null;

  const paramName = getSingleIdentifierParam(fn);
  if (!paramName) return null;

  const keys = extractRelationKeys(fn.body, paramName);
  if (!keys || keys.length === 0) return null;

  const f = ts.factory;
  return f.updateCallExpression(
    call, call.expression, call.typeArguments,
    [f.createArrayLiteralExpression(keys.map(k => f.createStringLiteral(k)))]
  );
}

// ---------------------------------------------------------------------------
// Call shape validation
// ---------------------------------------------------------------------------

/**
 * Validate that `call` is `<typhexExpr>.<joinMethod>(arrow)` — returns the
 * arrow when it matches, or null when it doesn't.
 */
function matchJoinCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.ArrowFunction | ts.FunctionExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (!JOIN_METHOD_NAMES.has(expr.name.text)) return null;
  if (!isTyphexType(expr.expression, checker)) return null;

  if (call.arguments.length !== 1) return null;
  const first = call.arguments[0];
  if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;
  return first;
}

/** Return the first parameter name if it's a plain identifier; null otherwise. */
function getSingleIdentifierParam(
  fn: ts.ArrowFunction | ts.FunctionExpression
): string | null {
  const param = fn.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return null;
  return param.text;
}

// ---------------------------------------------------------------------------
// Body shapes: p => ({ author: p.author }) or p => p.author
// ---------------------------------------------------------------------------

/**
 * Parse the arrow body into a list of relation keys. Supports both
 * `p => ({ author: p.author })` (object literal) and `p => p.author`
 * (single member access) forms.
 */
function extractRelationKeys(
  body: ts.ConciseBody,
  paramName: string
): string[] | null {
  if (ts.isBlock(body)) return null;

  // Form 1: p => ({ author: p.author }) — object literal body
  const objLit = unwrapObjectLiteral(
    ts.isParenthesizedExpression(body) ? body.expression : (body as ts.Expression)
  );
  if (objLit) return extractKeysFromObjectLiteral(objLit);

  // Form 2: p => p.author — single member access
  if (ts.isPropertyAccessExpression(body)) {
    const path = memberPath(body, paramName);
    if (!path || path.length === 0) return null;
    return [path[0]];
  }

  return null;
}

/** Collect the property key names from an object literal; null if any entry is unsupported. */
function extractKeysFromObjectLiteral(
  objLit: ts.ObjectLiteralExpression
): string[] | null {
  const keys: string[] = [];
  for (const prop of objLit.properties) {
    if (!ts.isPropertyAssignment(prop)) return null;
    const keyName = getObjectLiteralKeyName(prop.name);
    if (!keyName) return null;
    keys.push(keyName);
  }
  return keys;
}

/** Extract the key text of an object literal property name (identifier or string literal). */
function getObjectLiteralKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name))    return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}
