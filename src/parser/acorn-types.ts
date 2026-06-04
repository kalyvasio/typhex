/**
 * Acorn AST node type used internally by the runtime parser. Acorn's typed
 * AST is opaque; we access node properties defensively via this alias.
 */

import type * as acorn from "acorn";

export type AcornExpr = acorn.Node & Record<string, unknown>;
