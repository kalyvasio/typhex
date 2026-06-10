/**
 * Runtime parsing for `.groupBy(...)` arrow lambdas into member paths and/or
 * positional column references.
 */

import type * as ESTree from "estree";
import type { AcornExpr } from "./acorn-types.js";
import { extractArrowBody, inferParamNames, parseExpressionSource } from "./arrow-source.js";
import { isArrayExpression, isMemberExpression, isNumberLiteral } from "./acorn-helpers.js";
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
export function parseArrowToGroupByPaths(
  fn: (...args: unknown[]) => unknown,
): Array<string[] | number> {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) return [];
  const paramName = inferParamNames(src)[0] ?? "u";

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
  if (isNumberLiteral(expr)) return [expr.value];

  if (isMemberExpression(expr)) {
    const path = resolvePathFromParam(expr, paramName);
    return path && path.length > 0 ? [path] : [];
  }

  if (isArrayExpression(expr)) {
    return collectGroupByArrayElements(expr.elements, paramName);
  }

  return [];
}

function collectGroupByArrayElements(
  elements: Array<AcornExpr | ESTree.SpreadElement | null>,
  paramName: string,
): Array<string[] | number> {
  const entries: Array<string[] | number> = [];
  for (const el of elements) {
    if (!el || el.type === "SpreadElement") continue;
    if (isNumberLiteral(el)) {
      entries.push(el.value);
      continue;
    }
    const path = resolvePathFromParam(el, paramName);
    if (path && path.length > 0) entries.push(path);
  }
  return entries;
}
