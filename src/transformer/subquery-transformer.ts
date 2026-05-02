/**
 * Helpers for capturing inline `Entity.query()[chain]` expressions as
 * subquery refs. The method-specific transformers still own the actual
 * `.where()` / `.select()` / `.orderBy()` IR rewrites.
 */

import * as ts from "typescript";
import type { IrSubqueryRef } from "../ir/types.js";
import { isTyphexType, type ScopeFrame } from "./shared.js";

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
  outerParamNames: string[],
  outerScope: ScopeFrame[] = [],
): IrSubqueryRef {
  const key = `_sub${capturedSubqueries.length}`;
  capturedSubqueries.push({ key, expr });
  const localParamNames = getSubqueryLocalParamNames(expr, outerParamNames, outerScope);
  return { kind: "subqueryRef", key, ...(localParamNames.length > 0 ? { localParamNames } : {}) };
}

export function getSubqueryLocalParamNames(
  expr: ts.Expression,
  outerParamNames: string[] = [],
  outerScope: ScopeFrame[] = [],
): string[] {
  const locals = new Set<string>();
  const outer = new Set(outerParamNames);
  for (const frame of outerScope) outer.add(frame.paramName);

  let cursor: ts.Expression | null = expr;
  while (cursor && ts.isCallExpression(cursor) && ts.isPropertyAccessExpression(cursor.expression)) {
    const method = cursor.expression.name.text;
    if (method === "where" || method === "having") {
      addWhereLocalParams(cursor, outer, locals);
    } else if (method === "select") {
      addSelectLocalParam(cursor, locals);
    } else if (method === "orderBy") {
      addOrderByLocalParam(cursor, locals);
    }
    if (method === "query") break;
    cursor = cursor.expression.expression;
  }

  return [...locals];
}

function findQueryCall(expr: ts.Expression, checker: ts.TypeChecker): ts.CallExpression | null {
  let cursor: ts.Expression | null = expr;
  while (cursor && ts.isCallExpression(cursor) && ts.isPropertyAccessExpression(cursor.expression)) {
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

function addWhereLocalParams(
  call: ts.CallExpression,
  outer: Set<string>,
  locals: Set<string>,
): void {
  const whereIr = call.arguments[0];
  if (!whereIr || !ts.isObjectLiteralExpression(whereIr)) return;
  const memberParams = new Set<string>();
  collectMemberParams(whereIr, memberParams);
  for (const param of memberParams) {
    if (!outer.has(param)) locals.add(param);
  }
}

function addSelectLocalParam(call: ts.CallExpression, locals: Set<string>): void {
  const selectIr = call.arguments[0];
  if (!selectIr || !ts.isObjectLiteralExpression(selectIr)) return;
  const param = readStringProperty(selectIr, "param");
  if (param && selectUsesParam(selectIr, param)) locals.add(param);
}

function addOrderByLocalParam(call: ts.CallExpression, locals: Set<string>): void {
  const orderBy = call.arguments[0];
  if (!orderBy || !ts.isObjectLiteralExpression(orderBy)) return;
  const expr = readObjectProperty(orderBy, "expr");
  if (!expr || !ts.isObjectLiteralExpression(expr)) return;
  const param = readStringProperty(expr, "param");
  if (param) locals.add(param);
}

function collectMemberParams(node: ts.Expression, out: Set<string>): void {
  if (!ts.isObjectLiteralExpression(node)) return;
  const kind = readStringProperty(node, "kind");
  if (kind === "member") {
    const param = readStringProperty(node, "param");
    if (param) out.add(param);
    return;
  }

  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const value = prop.initializer;
    if (ts.isObjectLiteralExpression(value)) {
      collectMemberParams(value, out);
      continue;
    }
    if (ts.isArrayLiteralExpression(value)) {
      for (const el of value.elements) {
        if (ts.isObjectLiteralExpression(el)) collectMemberParams(el, out);
      }
    }
  }
}

function selectUsesParam(selectIr: ts.ObjectLiteralExpression, param: string): boolean {
  const paths = readObjectProperty(selectIr, "paths");
  if (paths && ts.isArrayLiteralExpression(paths) && paths.elements.length > 0) return true;

  const aggregates = readObjectProperty(selectIr, "aggregates");
  if (!aggregates || !ts.isArrayLiteralExpression(aggregates)) return false;
  const params = new Set<string>();
  for (const aggregate of aggregates.elements) {
    if (ts.isObjectLiteralExpression(aggregate)) collectMemberParams(aggregate, params);
  }
  return params.has(param);
}

function readObjectProperty(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!isPropertyNamed(prop.name, name)) continue;
    return prop.initializer;
  }
  return undefined;
}

function readStringProperty(obj: ts.ObjectLiteralExpression, name: string): string | null {
  const value = readObjectProperty(obj, name);
  return value && ts.isStringLiteral(value) ? value.text : null;
}

function isPropertyNamed(name: ts.PropertyName, expected: string): boolean {
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === expected;
}
