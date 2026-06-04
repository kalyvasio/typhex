/**
 * Small TypeScript AST helpers shared by per-method transformers (where,
 * select, orderBy, join): unwrap literals, match Typhex method calls, etc.
 */

import ts from "typescript";

export function unwrapObjectLiteral(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  return ts.isObjectLiteralExpression(inner) ? inner : null;
}

export function isIdentifierNamed(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

export function getArrowExpressionBody(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  if (!ts.isBlock(fn.body)) return fn.body;
  if (fn.body.statements.length !== 1) return null;
  const st = fn.body.statements[0];
  if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
  return st.expression;
}

export function matchTyphexMethodCall(
  call: ts.CallExpression,
  methodName: string,
  checker: ts.TypeChecker,
  isTyphex: (receiver: ts.Expression, checker: ts.TypeChecker) => boolean,
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
