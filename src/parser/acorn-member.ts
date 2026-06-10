/**
 * Member-path resolution for acorn ASTs: `u.author.name` → { param, path }.
 */

import type { AcornExpr } from "./acorn-types.js";
import { isIdentifier, isMemberExpression, memberObjectExpr } from "./acorn-helpers.js";

/**
 * Walk a MemberExpression chain rooted at one of `params` and return the
 * parameter name and the property path. Returns null if the chain isn't
 * rooted at a known parameter or uses computed/non-identifier accesses.
 */
export function resolveMemberPath(
  node: AcornExpr,
  params: string[],
): { param: string; path: string[] } | null {
  if (isIdentifier(node) && params.includes(node.name)) {
    return { param: node.name, path: [] };
  }
  if (!isMemberExpression(node) || node.computed) return null;
  if (!isIdentifier(node.property)) return null;

  const object = memberObjectExpr(node);
  if (!object) return null;

  const parent = resolveMemberPath(object, params);
  if (!parent) return null;
  return { param: parent.param, path: [...parent.path, node.property.name] };
}

/** Same as resolveMemberPath but constrained to a single parameter name. */
export function resolvePathFromParam(node: AcornExpr, paramName: string): string[] | null {
  const resolved = resolveMemberPath(node, [paramName]);
  return resolved ? resolved.path : null;
}
