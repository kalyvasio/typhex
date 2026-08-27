/**
 * Canonical aggregate function names and normalization from JS stub
 * identifiers (e.g. `groupConcat`) to IR func names (`GROUP_CONCAT`).
 * Shared by runtime parser and compile-time transformer.
 */

import type { IrAggregate, IrNode } from "../ir/types.js";

/** Recognized aggregate function names in IR. */
export const AGGREGATE_FUNCS: ReadonlySet<IrAggregate["func"]> = new Set([
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

const SEPARATOR_ARG_INDEX: Partial<Record<IrAggregate["func"], number>> = {
  GROUP_CONCAT: 1,
  STRING_AGG: 1,
};

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
  return toIrAggregateFunc(name) !== null;
}

export function toIrAggregateFunc(rawName: string): IrAggregate["func"] | null {
  const func = toIrFuncName(rawName);
  return AGGREGATE_FUNCS.has(func as IrAggregate["func"]) ? (func as IrAggregate["func"]) : null;
}

export function getAggregateSeparatorArgIndex(func: IrAggregate["func"]): number | null {
  return SEPARATOR_ARG_INDEX[func] ?? null;
}

export function buildIrAggregate(
  func: IrAggregate["func"],
  arg: IrNode | null,
  distinct: boolean,
  separator?: string,
): IrAggregate {
  return {
    kind: "aggregate",
    func,
    arg,
    ...(distinct ? { distinct: true } : {}),
    ...(getAggregateSeparatorArgIndex(func) !== null && separator !== undefined
      ? { separator }
      : {}),
  };
}
