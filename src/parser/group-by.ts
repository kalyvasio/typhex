/**
 * Runtime parsing for `.groupBy(...)` arrow lambdas into member paths and/or
 * positional column references.
 */

import type { AcornExpr } from "./acorn-types.js";
import { parseExpressionSource } from "./arrow-source.js";
import { isNumberLiteral } from "./acorn-helpers.js";
import { resolvePathFromParam } from "./acorn-member.js";

/**
 * Parse a `.groupBy(...)` arrow into an array of member paths and/or
 * positional column references.
 *
 * Supported shapes:
 * - `o => o.category`              → `[["category"]]`
 * - `o => 1`                       → `[1]` (positional)
 * - `o => [o.a, o.b, 2]`           → `[["a"], ["b"], 2]`
 *
 * Returns an empty array for unrecognized shapes.
 */
export function parseArrowToGroupByPaths(fn: (...args: unknown[]) => unknown): Array<string[] | number> {
  const src = fn.toString();
  const idx = src.indexOf("=>");
  if (idx === -1) return [];

  const body = src.slice(idx + 2).trim();
  const paramName = src.slice(0, idx).replaceAll(/[()]/g, "").trim() || "u";

  let expr: AcornExpr;
  try {
    expr = parseExpressionSource(body);
  } catch {
    return [];
  }

  return extractGroupByEntries(expr, paramName);
}

/** Dispatch groupBy body expression to the right extractor for its shape. */
function extractGroupByEntries(expr: AcornExpr, paramName: string): Array<string[] | number> {
  if (isNumberLiteral(expr)) {
    const n = expr as AcornExpr & { value?: number };
    return [n.value as number];
  }

  if (expr.type === "MemberExpression") {
    const path = resolvePathFromParam(expr, paramName);
    return path && path.length > 0 ? [path] : [];
  }

  if (expr.type === "ArrayExpression") {
    const arr = expr as AcornExpr & { elements?: Array<AcornExpr | null> };
    return collectGroupByArrayElements(arr.elements ?? [], paramName);
  }

  return [];
}

function collectGroupByArrayElements(
  elements: Array<AcornExpr | null>,
  paramName: string,
): Array<string[] | number> {
  const entries: Array<string[] | number> = [];
  for (const el of elements) {
    if (!el) continue;
    if (isNumberLiteral(el)) {
      entries.push((el as AcornExpr & { value?: number }).value as number);
      continue;
    }
    const path = resolvePathFromParam(el, paramName);
    if (path && path.length > 0) entries.push(path);
  }
  return entries;
}
