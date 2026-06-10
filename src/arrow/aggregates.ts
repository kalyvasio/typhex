/**
 * Canonical aggregate function names and normalization from JS stub
 * identifiers (e.g. `groupConcat`) to IR func names (`GROUP_CONCAT`).
 * Shared by runtime parser and compile-time transformer.
 */

/** Recognized aggregate function names in IR. */
export const AGGREGATE_FUNCS = new Set([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT",
  "GROUP_CONCAT",
  "STRING_AGG",
  "ARRAY_AGG",
  "JSON_AGG",
]);

const AGGREGATE_FUNC_MAP: Record<string, string> = {
  groupconcat: "GROUP_CONCAT",
  stringagg: "STRING_AGG",
  arrayagg: "ARRAY_AGG",
  jsonagg: "JSON_AGG",
};

/** Map a JS identifier (e.g. `count`, `groupConcat`) to the canonical IR func name. */
export function toIrFuncName(rawName: string): string {
  return AGGREGATE_FUNC_MAP[rawName.toLowerCase()] ?? rawName.toUpperCase();
}

/** True if `name` is a known aggregate after normalization. */
export function isAggregateFunc(name: string): boolean {
  return AGGREGATE_FUNCS.has(toIrFuncName(name));
}
