/**
 * ESTree node aliases for the runtime parser. Acorn's AST conforms to ESTree;
 * these types replace the previous opaque `acorn.Node & Record<string, unknown>`.
 */

import type * as ESTree from "estree";

/** ESTree node with optional acorn source offsets. */
export type AcornNode = ESTree.Node & { start?: number; end?: number };
export type AcornExpr = ESTree.Expression;
export type AcornPattern = ESTree.Pattern;
export type AcornFunctionBody = ESTree.BlockStatement | ESTree.Expression;
