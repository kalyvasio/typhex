/**
 * TypeScript AST member-path resolution for transformer predicates and selects.
 * Supports multi-param join shapes like `(u, posts) => u.id === posts.authorId`.
 */

import ts from "typescript";

export interface ResolvedMember {
  param: string;
  path: string[];
}

export function resolveMemberPath(
  expr: ts.PropertyAccessExpression,
  paramNames: string[],
): ResolvedMember | null {
  const parts: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current) && paramNames.includes(current.text)) {
    return { param: current.text, path: parts };
  }
  return null;
}

export function memberPath(expr: ts.PropertyAccessExpression, paramName: string): string[] | null {
  const result = resolveMemberPath(expr, [paramName]);
  return result ? result.path : null;
}
