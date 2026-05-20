/**
 * Input resolvers: normalise the three QB method input shapes
 * (pre-built IR | arrow function | string / string[]) to IR structures.
 */
import type {
  IrHaving,
  IrNode,
  IrOrderBy,
  IrSelect,
  IrWhere,
  OrderDirection,
} from "../ir/types.js";
import { isIrSelect, isIrOrderBy, isIrWhere } from "../ir/types.js";
import {
  parseArrowToIr,
  parseArrowToIrPredicate,
  parseArrowToIrSelect,
  parseArrowToGroupByPaths,
  parseArrowToUpdateSet,
} from "./parse-arrow.js";
import { DEFAULT_ROW_PARAM } from "../orm/helpers/query-plan/query-plan.js";

/** Resolve a where input (pre-built predicate IR or arrow fn) to an IrWhere. */
export function resolveWhereIr(
  input: IrWhere | ((entity: unknown) => boolean),
  paramKeys: string[] = [],
  subqueryKeys: string[] = [],
): IrWhere {
  if (isIrWhere(input)) return input;
  try {
    return parseArrowToIrPredicate(input as (u: any) => boolean, { paramKeys, subqueryKeys });
  } catch (e) {
    throw new Error(
      "Failed to parse arrow predicate: " + (e instanceof Error ? e.message : String(e)),
    );
  }
}

export function resolveHavingIr(
  input: IrHaving | ((entity: unknown) => boolean),
  paramKeys: string[] = [],
  subqueryKeys: string[] = [],
): IrHaving {
  return resolveWhereIr(input, paramKeys, subqueryKeys);
}

/** Resolve an entity-table join ON input (pre-built predicate IR or arrow fn) to an IrWhere. */
export function resolveJoinOnIr(
  joinType: string,
  input: IrWhere | ((joined: unknown, row: unknown) => boolean),
): IrWhere {
  if (isIrWhere(input)) return input;
  try {
    return parseArrowToIrPredicate(input as (...args: any[]) => boolean);
  } catch (e) {
    throw new Error(
      `Failed to parse ${joinType}Join ON predicate: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Resolve an orderBy input (pre-built IrOrderBy, string, or arrow fn) to an IrOrderBy. */
export function resolveOrderBy(
  input: IrOrderBy | string | ((row: unknown) => unknown),
  direction: OrderDirection = "asc",
  paramKeys: string[] = [],
): IrOrderBy {
  if (isIrOrderBy(input)) return input;
  if (typeof input === "function") {
    try {
      const ir = parseArrowToIr(input as (u: any) => any, { paramKeys });
      if (ir.kind === "aggregate") {
        throw new Error(
          "[typhex] orderBy does not support aggregate functions directly. " +
            "Select the aggregate with an alias first (e.g. .select(p => ({ total: sum(p.price) }))), " +
            'then orderBy the alias as a string: .orderBy("total", "desc").',
        );
      }
      if (ir.kind !== "member" || ir.path.length === 0) {
        if (ir.kind === "case" || ir.kind === "binary") {
          return { expr: ir, direction };
        }
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
  paramKeys: string[] = [],
): IrSelect {
  if (typeof input === "function") {
    const parsed = parseArrowToIrSelect(input as (...args: any[]) => any, paramKeys);
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

export interface ResolvedUpdateSet {
  set?: Record<string, unknown>;
  setIr?: Record<string, IrNode>;
}

/** Resolve an update input (literal map or arrow fn) for the query planner. */
export function resolveUpdateSet(
  input: Record<string, unknown> | ((row: unknown) => Record<string, unknown>),
): ResolvedUpdateSet {
  if (typeof input !== "function") {
    return { set: input };
  }
  try {
    return { setIr: parseArrowToUpdateSet(input) };
  } catch (e) {
    throw new Error(
      "Failed to parse update lambda: " + (e instanceof Error ? e.message : String(e)),
    );
  }
}
