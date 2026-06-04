/**
 * Small acorn AST shape checks used across predicate walking, group-by,
 * select, and update parsing.
 */

import type { AcornExpr } from "./acorn-types.js";

/** True if `node` is an Identifier; if `name` is given, also checks it matches. */
export function isIdent(node: AcornExpr | null | undefined, name?: string): boolean {
  if (!node || node.type !== "Identifier") return false;
  const n = node as AcornExpr & { name?: string };
  return name === undefined || n.name === name;
}

/** True if `node` is any acorn Literal (string, number, boolean, null, regex). */
export function isLiteral(node: AcornExpr | null | undefined): boolean {
  return !!node && node.type === "Literal";
}

/** True if `node` is a string literal. */
export function isStringLiteral(node: AcornExpr): boolean {
  const n = node as AcornExpr & { value?: unknown };
  return node.type === "Literal" && typeof n.value === "string";
}

/** True if `node` is a numeric literal. */
export function isNumberLiteral(node: AcornExpr): boolean {
  const n = node as AcornExpr & { value?: unknown };
  return node.type === "Literal" && typeof n.value === "number";
}
