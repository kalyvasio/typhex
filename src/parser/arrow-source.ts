/**
 * String-level helpers for runtime arrow parsing: extract body from
 * `fn.toString()`, infer parameter names, and parse expression source via acorn.
 */

import * as acorn from "acorn";
import type { AcornExpr, AcornNode } from "./acorn-types.js";

/** Parse a single JS expression source string into an acorn AST node; throws on failure. */
export function parseExpressionSource(src: string): AcornExpr {
  const ast = acorn.parse(src, { ecmaVersion: "latest", locations: true });
  const stmt = ast.body[0];
  if (stmt?.type !== "ExpressionStatement" || !stmt.expression) {
    throw new Error("Expected expression: " + src);
  }
  // Acorn's Expression type is ESTree-compatible; assert once at the parse boundary.
  return stmt.expression as AcornExpr;
}

/** Slice the original source text covered by an acorn node using its start/end offsets. */
export function sliceNodeSource(node: AcornNode, source: string): string | null {
  const start = node.start;
  const end = node.end;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return source.slice(start, end);
}

/**
 * Extract the body expression source from an arrow function's `toString()`.
 * Supports expression bodies and single-`return` block bodies.
 */
export function extractArrowBody(src: string): string | null {
  const idx = src.indexOf("=>");
  if (idx === -1) return null;
  const body = src.slice(idx + 2).trim();
  if (!body.startsWith("{")) return body;

  const inner = body.slice(1, -1).trim();
  const returnMatch = inner.match(/^return\s+(.+);?\s*$/s);
  if (!returnMatch) return null;
  return returnMatch[1].replace(/;\s*$/, "").trim();
}

/**
 * Parse parameter names out of an arrow's source text, handling
 * `async` prefixes, parenthesized lists, and inline type annotations.
 * Returns `["u"]` if nothing can be inferred.
 */
export function inferParamNames(src: string): string[] {
  const idx = src.indexOf("=>");
  if (idx === -1) return ["u"];

  let before = src
    .slice(0, idx)
    .replace(/^\s*async\s+/, "")
    .trim();
  if (before.startsWith("(") && before.endsWith(")")) {
    before = before.slice(1, -1);
  }
  if (!before) return ["u"];

  const names = before
    .split(",")
    .map((p) => p.trim().split(/[\s:]/)[0])
    .filter(Boolean);
  return names.length > 0 ? names : ["u"];
}

/** Strip outer parens from `({ … })` bodies and wrap in `(…)` for expression parsing. */
export function normalizeSelectBodySource(body: string): string {
  const inner = body.startsWith("(") && body.endsWith(")") ? body.slice(1, -1) : body;
  return `(${inner})`;
}
