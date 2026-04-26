/**
 * Internal helpers for building IR. Not exported from public API.
 * Used by Entity and other internal modules.
 */

import type { IrNode } from "../ir/types.js";
import { isRecord } from "../utils.js";

const DEFAULT_ROW_PARAM = "u";

/** Build IR for: column === value. Used for PK lookups, etc. */
export function whereColumnEq(column: string, value: unknown, param = DEFAULT_ROW_PARAM): IrNode {
  return {
    kind: "binary",
    op: "===",
    left: { kind: "member", param, path: [column] },
    right: { kind: "const", value },
  };
}

/** Build IR for: column IN array. Used for batch relation loading. */
export function whereColumnIn(
  column: string,
  values: unknown[],
  param = DEFAULT_ROW_PARAM,
): IrNode {
  return {
    kind: "in",
    left: { kind: "member", param, path: [column] },
    right: { kind: "const", value: values },
  };
}

/** Combine two IR nodes with AND. Used when relation has both base filter and user where. */
export function whereAnd(left: IrNode, right: IrNode): IrNode {
  return { kind: "binary", op: "&&", left, right };
}

/** Serialize a row's values for the given columns into a stable string key.
 *  Used for composite-key grouping/lookup when columns > 1. */
export function makeCompositeKey(row: Record<string, unknown>, cols: string[]): string {
  return cols.map((c) => JSON.stringify(row[c] ?? null)).join("\x00");
}

/**
 * Build a WHERE IR that filters rows by a set of columns using AND-of-INs.
 *   Single column:   WHERE tgtCol IN (v1, v2, ...)
 *   Multiple columns: WHERE tgtCol1 IN (v1a, v1b) AND tgtCol2 IN (v2a, v2b) AND ...
 *
 * Collects distinct non-null values for each srcCol from `rows` and compares
 * them against the corresponding tgtCol in the target query. The result is the
 * cross-product of distinct values per column — a superset of the exact matches.
 * The in-memory grouping step (groupByCompositeKey / indexByCompositeKey)
 * corrects any over-fetch.
 *
 * Returns null when any column produces an empty value set (nothing to fetch).
 */
export function buildFetchByIdIr(
  rows: Record<string, unknown>[],
  srcCols: string[],
  tgtCols: string[],
): IrNode | null {
  let where: IrNode | null = null;
  for (let i = 0; i < tgtCols.length; i++) {
    const vals = [...new Set(rows.map((r) => r[srcCols[i]]).filter((v) => v != null))];
    if (vals.length === 0) return null;
    const clause = whereColumnIn(tgtCols[i], vals as unknown[]);
    where = where ? whereAnd(where, clause) : clause;
  }
  return where;
}

/** Build WHERE IR for a primary key match. Accepts a Record keyed by PK column names
 *  (entity instance, composite id object, or the result of `pkToRecord`). */
export function buildFindByIdIr(pkColumns: string[], id: Record<string, unknown>): IrNode {
  let node = whereColumnEq(pkColumns[0], id[pkColumns[0]]);
  for (let i = 1; i < pkColumns.length; i++) {
    node = whereAnd(node, whereColumnEq(pkColumns[i], id[pkColumns[i]]));
  }
  return node;
}

/** Normalise a user-supplied PK value to a Record.
 *  Scalar values (e.g. `5`) are wrapped as `{ [col]: value }` for single-column PKs. */
export function pkToRecord(pkColumns: string[], id: unknown): Record<string, unknown> {
  return isRecord(id) ? id : { [pkColumns[0]]: id };
}
