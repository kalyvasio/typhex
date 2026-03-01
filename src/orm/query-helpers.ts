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
