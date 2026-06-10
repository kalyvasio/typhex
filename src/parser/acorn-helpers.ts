/**
 * ESTree type guards and small accessors used across predicate walking,
 * group-by, select, and update parsing.
 */

import type * as ESTree from "estree";
import type { AcornExpr, AcornFunctionBody, AcornNode } from "./acorn-types.js";

const NON_EXPRESSION_NODE_TYPES = new Set([
  "SpreadElement",
  "PrivateIdentifier",
  "Super",
  "ObjectPattern",
  "ArrayPattern",
  "RestElement",
  "AssignmentPattern",
]);

/** True when a node is an expression shape (excludes spread, patterns, super, etc.). */
export function isExpressionNode(node: AcornNode): node is AcornExpr {
  return !NON_EXPRESSION_NODE_TYPES.has(node.type);
}

export function isIdentifier(node: AcornNode | null | undefined): node is ESTree.Identifier {
  return !!node && node.type === "Identifier";
}

/** True if `node` is an Identifier; if `name` is given, also checks it matches. */
export function isIdent(
  node: AcornNode | null | undefined,
  name?: string,
): node is ESTree.Identifier {
  return isIdentifier(node) && (name === undefined || node.name === name);
}

export function isLiteral(node: AcornNode | null | undefined): node is ESTree.Literal {
  return !!node && node.type === "Literal";
}

/** True if `node` is a string literal. */
export function isStringLiteral(node: AcornNode): node is ESTree.Literal & { value: string } {
  return isLiteral(node) && typeof node.value === "string";
}

/** True if `node` is a numeric literal. */
export function isNumberLiteral(node: AcornNode): node is ESTree.Literal & { value: number } {
  return isLiteral(node) && typeof node.value === "number";
}

export function isMemberExpression(
  node: AcornNode | null | undefined,
): node is ESTree.MemberExpression {
  return !!node && node.type === "MemberExpression";
}

/** MemberExpression.object when it is a normal expression (not `super`). */
export function memberObjectExpr(node: ESTree.MemberExpression): AcornExpr | null {
  return node.object.type === "Super" ? null : node.object;
}

export function isCallExpression(
  node: AcornNode | null | undefined,
): node is ESTree.CallExpression {
  return !!node && node.type === "CallExpression";
}

export function isObjectExpression(
  node: AcornNode | null | undefined,
): node is ESTree.ObjectExpression {
  return !!node && node.type === "ObjectExpression";
}

export function isArrayExpression(
  node: AcornNode | null | undefined,
): node is ESTree.ArrayExpression {
  return !!node && node.type === "ArrayExpression";
}

export function isProperty(node: AcornNode | null | undefined): node is ESTree.Property {
  return !!node && node.type === "Property";
}

export function isSpreadElement(node: AcornNode | null | undefined): node is ESTree.SpreadElement {
  return !!node && node.type === "SpreadElement";
}

export function isReturnStatement(
  node: AcornNode | null | undefined,
): node is ESTree.ReturnStatement {
  return !!node && node.type === "ReturnStatement";
}

export function isBlockStatement(
  node: AcornNode | null | undefined,
): node is ESTree.BlockStatement {
  return !!node && node.type === "BlockStatement";
}

export function isArrowFunctionExpression(
  node: AcornNode | null | undefined,
): node is ESTree.ArrowFunctionExpression {
  return !!node && node.type === "ArrowFunctionExpression";
}

export function isFunctionExpression(
  node: AcornNode | null | undefined,
): node is ESTree.FunctionExpression {
  return !!node && node.type === "FunctionExpression";
}

export function isBinaryOrLogicalExpression(
  node: AcornNode,
): node is ESTree.BinaryExpression | ESTree.LogicalExpression {
  return node.type === "BinaryExpression" || node.type === "LogicalExpression";
}

export function isUnaryExpression(node: AcornNode): node is ESTree.UnaryExpression {
  return node.type === "UnaryExpression";
}

/** Resolve a non-computed object property key to its string name. */
export function propertyKeyName(key: ESTree.Expression | ESTree.PrivateIdentifier): string | null {
  if (isIdentifier(key)) return key.name;
  if (isLiteral(key) && typeof key.value === "string") return key.value;
  return null;
}

/** Object-literal property value — excludes destructuring patterns. */
export function objectPropertyValue(value: ESTree.Expression | ESTree.Pattern): AcornExpr | null {
  return isExpressionNode(value) ? value : null;
}

/** First identifier param name from an arrow/function callback, or null. */
export function firstParamName(params: ESTree.Pattern[]): string | null {
  const param = params[0];
  return isIdentifier(param) ? param.name : null;
}

/** Expression body of a relation callback: expression body or single `return`. */
export function extractCallbackExpression(body: AcornFunctionBody, method: string): AcornExpr {
  if (isBlockStatement(body)) {
    const first = body.body[0];
    if (!isReturnStatement(first) || !first.argument) {
      throw new Error(`Unsupported .${method}() callback: need return`);
    }
    return first.argument;
  }
  return body;
}
