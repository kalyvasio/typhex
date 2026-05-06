/**
 * Input resolvers: normalise the three QB method input shapes
 * (pre-built IR | arrow function | string / string[]) to IR structures.
 */
import type { IrNode, IrOrderBy, IrSelect, OrderDirection } from "../ir/types.js";
import { isIrNode, isIrSelect, isIrOrderBy } from "../ir/types.js";
import { parseArrowToIr, parseArrowToIrSelect, parseArrowToGroupByPaths } from "./parse-arrow.js";
import { DEFAULT_ROW_PARAM } from "../orm/helpers/query-plan/query-plan.js";

/** Resolve a where input (pre-built IR node or arrow fn) to an IrNode. */
export function resolveWhereIr(
  input: IrNode | ((entity: unknown) => boolean),
  paramKeys: string[] = [],
  paramValues?: Record<string, unknown>,
): IrNode {
  if (isIrNode(input)) return input;
  try {
    return parseArrowToIr(input as (u: any) => boolean, { paramKeys, paramValues });
  } catch (e) {
    throw new Error(
      "Failed to parse arrow predicate: " + (e instanceof Error ? e.message : String(e)),
    );
  }
}

/** Resolve an orderBy input (pre-built IrOrderBy, string, or arrow fn) to an IrOrderBy. */
export function resolveOrderBy(
  input: IrOrderBy | string | ((row: unknown) => unknown),
  direction: OrderDirection = "asc",
): IrOrderBy {
  if (isIrOrderBy(input)) return input;
  if (typeof input === "function") {
    try {
      const ir = parseArrowToIr(input as (u: any) => any, { paramKeys: [] });
      if (ir.kind === "aggregate") {
        throw new Error(
          "[typhex] orderBy does not support aggregate functions directly. " +
            "Select the aggregate with an alias first (e.g. .select(p => ({ total: sum(p.price) }))), " +
            'then orderBy the alias as a string: .orderBy("total", "desc").',
        );
      }
      if (ir.kind !== "member" || !ir.path || ir.path.length === 0) {
        throw new Error(
          "[typhex] orderBy lambda must select a column (e.g. u => u.name), not the whole row (e.g. u => u)",
        );
      }
      return { expr: ir, direction };
    } catch (e) {
      throw new Error(
        "Failed to parse orderBy lambda: " + (e instanceof Error ? e.message : String(e)),
      );
    }
  }
  const segments = input.split(".").map((s) => s.trim());
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new Error(
      '[typhex] orderBy column must be a non-empty dot-separated path (e.g. "company.name")',
    );
  }
  return {
    expr: { kind: "member", param: DEFAULT_ROW_PARAM, path: segments },
    direction,
  };
}

/** Resolve a select input (pre-built IrSelect, column string array, or arrow fn) to an IrSelect. */
export function resolveSelectIr(
  input: IrSelect | string[] | ((row: unknown) => Record<string, unknown>),
): IrSelect {
  if (typeof input === "function") {
    const parsed = parseArrowToIrSelect(input as (...args: any[]) => any);
    if (!parsed) {
      throw new Error(
        "select(): could not parse lambda at runtime. Use the Typhex transformer for complex selects, or pass column names / IrSelect.",
      );
    }
    return parsed;
  }
  if (isIrSelect(input)) return input;
  // string[] — each entry becomes a single-segment path
  return { param: DEFAULT_ROW_PARAM, paths: input.map((c) => [c]), aliases: input };
}

/** Resolve a groupBy input (arrow fn, string/number array, or mixed) to Array<string[] | number>. */
export function resolveGroupByPaths(
  columnOrFn: string | string[] | number | number[] | ((row: unknown) => unknown),
  ...rest: (string | number)[]
): Array<string[] | number> {
  if (typeof columnOrFn === "function") {
    const entries = parseArrowToGroupByPaths(columnOrFn as (row: any) => any);
    if (entries.length === 0) {
      throw new Error(
        "[typhex] .groupBy() could not parse the provided function — no column paths were resolved.",
      );
    }
    return entries;
  }
  const cols: Array<string | number> = Array.isArray(columnOrFn)
    ? columnOrFn
    : [columnOrFn, ...rest];
  return cols.map((c): string[] | number => {
    const n = Number(c);
    if (Number.isInteger(n)) return n;
    return String(c).split(".");
  });
}

/** Resolve a join-hint input (string array or arrow fn) to relation key strings. */
export function resolveJoinKeys(fn: string[] | ((row: unknown) => unknown)): string[] {
  if (Array.isArray(fn)) return [...new Set(fn)];
  try {
    const parsed = parseArrowToIrSelect(fn as (...args: any[]) => any);
    if (parsed) {
      const keys: string[] = [];
      for (const path of parsed.paths) {
        if (path.length >= 1) keys.push(path[0]);
      }
      for (const rel of parsed.relations ?? []) {
        keys.push(rel.name);
      }
      return [...new Set(keys)];
    }
    // Fallback: single member access p => p.author
    const ir = parseArrowToIr(fn as (u: any) => any, { paramKeys: [] });
    if (ir.kind === "member" && ir.path.length >= 1) return [ir.path[0]];
    return [];
  } catch {
    return [];
  }
}
