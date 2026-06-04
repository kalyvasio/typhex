/**
 * Member-path resolution for acorn ASTs: `u.author.name` → { param, path }.
 */

import type { AcornExpr } from "./acorn-types.js";

/**
 * Walk a MemberExpression chain rooted at one of `params` and return the
 * parameter name and the property path. Returns null if the chain isn't
 * rooted at a known parameter or uses computed/non-identifier accesses.
 */
export function resolveMemberPath(
  node: AcornExpr,
  params: string[],
): { param: string; path: string[] } | null {
  const n = node as AcornExpr & { type?: string; name?: string; computed?: boolean; object?: AcornExpr; property?: AcornExpr };
  if (n.type === "Identifier" && params.includes(n.name ?? "")) {
    return { param: n.name!, path: [] };
  }
  if (n.type !== "MemberExpression" || n.computed) return null;

  const prop = n.property;
  if (!prop || prop.type !== "Identifier") return null;
  const propName = (prop as AcornExpr & { name?: string }).name;
  if (!propName) return null;

  const parent = resolveMemberPath(n.object as AcornExpr, params);
  if (!parent) return null;
  return { param: parent.param, path: [...parent.path, propName] };
}

/** Same as resolveMemberPath but constrained to a single parameter name. */
export function resolvePathFromParam(node: AcornExpr, paramName: string): string[] | null {
  const resolved = resolveMemberPath(node, [paramName]);
  return resolved ? resolved.path : null;
}
