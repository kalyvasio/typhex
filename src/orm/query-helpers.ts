/**
 * Internal helpers for building IR. Not exported from public API.
 * Used by Entity and other internal modules.
 */

import type { IrNode } from "../ir/types.js";

const DEFAULT_ROW_PARAM = "u";

/** Build IR for: column === value. Used for PK lookups, etc. */
export function whereColumnEq(
  column: string,
  value: unknown,
  param = DEFAULT_ROW_PARAM
): IrNode {
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
  param = DEFAULT_ROW_PARAM
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
