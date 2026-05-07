/**
 * Helpers for capturing inline `Entity.query()[chain]` expressions as
 * subquery refs. The method-specific transformers still own the actual
 * `.where()` / `.select()` / `.orderBy()` IR rewrites.
 */

import * as ts from "typescript";
import type { IrSubqueryRef } from "../ir/types.js";
import { isTyphexType } from "./shared.js";

export interface CapturedSubquery {
  key: string;
  expr: ts.Expression;
}

export function isTyphexQueryChain(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  return findQueryCall(expr, checker) !== null;
}

export function captureSubqueryRef(
  expr: ts.Expression,
  capturedSubqueries: CapturedSubquery[],
): IrSubqueryRef {
  const key = `_sub${capturedSubqueries.length}`;
  capturedSubqueries.push({ key, expr });
  return { kind: "subqueryRef", key };
}

function findQueryCall(expr: ts.Expression, checker: ts.TypeChecker): ts.CallExpression | null {
  let cursor: ts.Expression | null = expr;
  while (
    cursor &&
    ts.isCallExpression(cursor) &&
    ts.isPropertyAccessExpression(cursor.expression)
  ) {
    if (cursor.expression.name.text === "query" && isTyphexQueryCall(cursor, checker)) {
      return cursor;
    }
    cursor = cursor.expression.expression;
  }
  return null;
}

function isTyphexQueryCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (isTyphexType(call, checker)) return true;
  return ts.isPropertyAccessExpression(call.expression)
    ? isTyphexType(call.expression.expression, checker)
    : false;
}
