/**
 * Shared arrow-expression rules used by both the runtime parser (acorn) and
 * the compile-time TypeScript transformer. Keeps allowed methods, default
 * param names, and relation-chain method names in one place.
 */

import type { IrBinary } from "../ir/types.js";

/** Default row parameter when inference fails (e.g. `u => …`). */
export const DEFAULT_ROW_PARAM = "u";

/** String methods permitted in WHERE predicates (receiver must be a member path). */
export const ALLOWED_METHODS = new Set(["startsWith", "endsWith", "includes"]);

/** Methods allowed on relation query chains inside select lambdas. */
export const RELATION_QUERY_METHODS = new Set([
  "query",
  "where",
  "orderBy",
  "limit",
  "offset",
  "select",
]);

/** Acorn binary/logical operator strings → IR binary ops (runtime parser only). */
export const ACORN_BINARY_OPS: Record<string, IrBinary["op"] | undefined> = {
  "&&": "&&",
  "||": "||",
  "==": "==",
  "===": "===",
  "!=": "!=",
  "!==": "!==",
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
};
