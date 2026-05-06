/**
 * Transformer for .orderBy() calls: converts a column-selector lambda
 * and optional direction into an IrOrderBy literal.
 */

import * as ts from "typescript";
import type { IrNode } from "../ir/types.js";
import {
  isTyphexType,
  matchTyphexMethodCall,
  memberPath,
  irOrderByToTsLiteral,
  type ScopeFrame,
} from "./shared.js";
import {
  captureSubqueryRef,
  isTyphexQueryChain,
  type CapturedSubquery,
} from "./subquery-transformer.js";

type Direction = "asc" | "desc";

/**
 * Rewrite a `.orderBy(p => p.col | Entity.query()...select(() => count()), "asc"|"desc")`
 * call on a Typhex Table/QueryBuilder into an IrOrderBy literal. Returns
 * null when the call shape isn't supported — the runtime parser handles it
 * then.
 */
export function transformOrderByCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  outerScope: ScopeFrame[] = [],
): ts.CallExpression | null {
  const fn = matchTyphexMethodCall(call, "orderBy", checker, isTyphexType);
  if (!fn) return null;

  const paramName = getFirstIdentifierParamName(fn);
  if (!paramName) return null;

  const capturedSubqueries: CapturedSubquery[] = [];
  const expr = extractOrderByExpr(fn.body, paramName, checker, capturedSubqueries, outerScope);
  if (!expr) return null;

  const direction = parseDirectionArg(call.arguments);
  if (direction === null) return null;

  const args: ts.Expression[] = [irOrderByToTsLiteral({ expr, direction })];
  if (capturedSubqueries.length > 0) {
    args.push(ts.factory.createStringLiteral(direction));
    args.push(buildSubqueryParamsLiteral(capturedSubqueries));
  }
  return ts.factory.updateCallExpression(call, call.expression, call.typeArguments, args);
}

/** Extract the sort-key expression from an orderBy lambda body — either a
 *  plain `p.col` member access or an inline `Entity.query()...select(() => count())` chain. */
function extractOrderByExpr(
  body: ts.ConciseBody,
  paramName: string,
  checker: ts.TypeChecker,
  capturedSubqueries: CapturedSubquery[],
  outerScope: ScopeFrame[] = [],
): IrNode | null {
  const path = extractColumnPath(body, paramName);
  if (path) return { kind: "member", param: paramName, path };
  if (ts.isExpression(body)) {
    if (isTyphexQueryChain(body, checker)) {
      return captureSubqueryRef(body, capturedSubqueries, [paramName], outerScope);
    }
  }
  return null;
}

function buildSubqueryParamsLiteral(
  capturedSubqueries: CapturedSubquery[],
): ts.ObjectLiteralExpression {
  const f = ts.factory;
  return f.createObjectLiteralExpression(
    capturedSubqueries.map((sub) => f.createPropertyAssignment(sub.key, sub.expr)),
  );
}

/** Return the first parameter's name if it's a plain identifier; null otherwise. */
function getFirstIdentifierParamName(fn: ts.ArrowFunction | ts.FunctionExpression): string | null {
  const param = fn.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return null;
  return param.text;
}

/**
 * Extract the `p.a.b` column path from an arrow body. The body must be a
 * direct property access on the lambda parameter.
 */
function extractColumnPath(body: ts.ConciseBody, paramName: string): string[] | null {
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
