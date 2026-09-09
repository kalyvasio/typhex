/**
 * Helpers for capturing inline `Entity.query()[chain]` expressions as
 * subquery refs. The method-specific transformers still own the actual
 * `.where()` / `.select()` / `.orderBy()` IR rewrites.
 */

import * as ts from "typescript";
import type { IrSubqueryRef } from "../ir/types.js";
import { isTyphexType } from "./shared.js";

export interface CapturedExpression {
  key: string;
  expr: ts.Expression;
}

export function isTyphexQueryChain(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  return findQueryCall(expr, checker) !== null;
}

export function captureSubqueryRef(
  expr: ts.Expression,
  capturedExpressions: CapturedExpression[],
): IrSubqueryRef {
  const index = capturedExpressions.filter((captured) => captured.key.startsWith("_sub")).length;
  const key = `_sub${index}`;
  capturedExpressions.push({ key, expr });
  return { kind: "subqueryRef", key };
}

export function buildParamsLiteral(
  freeVars: string[],
  capturedExpressions: CapturedExpression[],
): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = freeVars.map((v) =>
    f.createShorthandPropertyAssignment(f.createIdentifier(v)),
  );
  for (const captured of capturedExpressions) {
    const key = captured.key.startsWith("@") ? f.createStringLiteral(captured.key) : captured.key;
    props.push(f.createPropertyAssignment(key, captured.expr));
  }
  return f.createObjectLiteralExpression(props);
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
