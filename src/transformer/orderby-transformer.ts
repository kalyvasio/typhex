/**
 * Transformer for .orderBy() calls: converts a column-selector lambda
 * and optional direction into an IrOrderBy literal.
 */

import * as ts from "typescript";
import {
  isTyphexType,
  matchTyphexMethodCall,
  memberPath,
  irOrderByToTsLiteral,
} from "./shared.js";

type Direction = "asc" | "desc";

/**
 * Rewrite a `.orderBy(p => p.col, "asc"|"desc")` call on a Typhex
 * Table/QueryBuilder into an IrOrderBy literal. Returns null when the call
 * shape isn't supported — the runtime parser handles it then.
 */
export function transformOrderByCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const fn = matchTyphexMethodCall(call, "orderBy", checker, isTyphexType);
  if (!fn) return null;

  const paramName = getFirstIdentifierParamName(fn);
  if (!paramName) return null;

  const path = extractColumnPath(fn.body, paramName);
  if (!path) return null;

  const direction = parseDirectionArg(call.arguments);
  if (direction === null) return null;

  return ts.factory.updateCallExpression(
    call, call.expression, call.typeArguments,
    [irOrderByToTsLiteral({ param: paramName, path, direction })]
  );
}

/** Return the first parameter's name if it's a plain identifier; null otherwise. */
function getFirstIdentifierParamName(
  fn: ts.ArrowFunction | ts.FunctionExpression
): string | null {
  const param = fn.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return null;
  return param.text;
}

/**
 * Extract the `p.a.b` column path from an arrow body. The body must be a
 * direct property access on the lambda parameter.
 */
function extractColumnPath(
  body: ts.ConciseBody,
  paramName: string
): string[] | null {
  if (!ts.isPropertyAccessExpression(body)) return null;
  const path = memberPath(body, paramName);
  return path && path.length > 0 ? path : null;
}

/**
 * The direction argument is optional; when present it MUST be a known string
 * literal ("asc" | "desc"). Anything else returns null to leave the call for
 * runtime parsing (preserving original semantics).
 */
function parseDirectionArg(args: ts.NodeArray<ts.Expression>): Direction | null {
  if (args.length < 2) return "asc";
  const dirArg = args[1];
  if (!ts.isStringLiteral(dirArg)) return null;
  if (dirArg.text !== "asc" && dirArg.text !== "desc") return null;
  return dirArg.text;
}
