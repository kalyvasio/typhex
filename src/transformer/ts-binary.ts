/**
 * Map TypeScript binary-operator SyntaxKind values to IR binary ops for the
 * compile-time where/having transformer.
 */

import ts from "typescript";
import type { IrBinary } from "../ir/types.js";

const BINARY_OP_MAP: Record<number, IrBinary["op"] | "in" | undefined> = {
  [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
  [ts.SyntaxKind.BarBarToken]: "||",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.InKeyword]: "in",
};

export function binaryOpFromSyntaxKind(kind: ts.SyntaxKind): IrBinary["op"] | "in" | null {
  return BINARY_OP_MAP[kind] ?? null;
}
