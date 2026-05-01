/**
 * Single shared builder for IrSubquery nodes. Both the TS transformer
 * (subquery-extract.ts -> chain walking) and the runtime QueryBuilder
 * (.toSubqueryIr) feed their inputs through this so the resulting IR is
 * uniform: outer-correlated params are computed, IrParam values are inlined
 * into whereIr, and selectCol/aggregate validity is checked.
 */

import type { IrNode, IrOrderBy, IrSubquery, IrSubqueryAggregate } from "./types.js";
import { collectParamNamesFromWhere, validateIrSubquery } from "./types.js";

export interface SubqueryBuilderInput {
  tableName: string;
  selectCol?: string;
  aggregate?: IrSubqueryAggregate;
  whereIr: IrNode | null;
  /** Optional runtime values for IrParam nodes referenced in `whereIr`.
   *  When provided, those IrParams are inlined to IrConst before storing. */
  whereParams?: Record<string, unknown>;
  innerParamNames?: string[];
  orderBy?: IrOrderBy[];
  limitNum?: number | null;
  offsetNum?: number | null;
  distinct?: { col: string } | true;
}

/** Inline IrParam → IrConst using `values`. Subquery RHS of IN is left alone
 *  (it carries its own param namespace). Returns a fresh tree. */
function inlineWhereParams(ir: IrNode, values: Record<string, unknown>): IrNode {
  switch (ir.kind) {
    case "param":
      return { kind: "const", value: values[ir.key] };
    case "binary":
      return {
        ...ir,
        left: inlineWhereParams(ir.left, values),
        right: inlineWhereParams(ir.right, values),
      };
    case "unary":
      return { ...ir, operand: inlineWhereParams(ir.operand, values) };
    case "in":
      return {
        ...ir,
        left: inlineWhereParams(ir.left, values),
        right:
          ir.right.kind === "subquery" || ir.right.kind === "param" || ir.right.kind === "const"
            ? ir.right
            : inlineWhereParams(ir.right, values),
      };
    case "call":
      return {
        ...ir,
        receiver: inlineWhereParams(ir.receiver, values),
        args: ir.args.map((a) => inlineWhereParams(a, values)),
      };
    default:
      return ir;
  }
}

/** Build a normalized IrSubquery from an input shape. Validates the result. */
export function buildIrSubquery(input: SubqueryBuilderInput): IrSubquery {
  const innerParamNames = input.innerParamNames ?? [];
  const inlinedWhere =
    input.whereIr && input.whereParams && Object.keys(input.whereParams).length > 0
      ? inlineWhereParams(input.whereIr, input.whereParams)
      : input.whereIr;

  const outerCorrelatedParams: string[] = [];
  if (inlinedWhere) {
    const seen = new Set<string>();
    collectParamNamesFromWhere(inlinedWhere, seen);
    const inner = new Set(innerParamNames);
    for (const n of seen) if (!inner.has(n)) outerCorrelatedParams.push(n);
  }

  const result: IrSubquery = {
    kind: "subquery",
    tableName: input.tableName,
    whereIr: inlinedWhere,
  };
  if (input.selectCol !== undefined) result.selectCol = input.selectCol;
  if (input.aggregate !== undefined) result.aggregate = input.aggregate;
  if (innerParamNames.length > 0) result.innerParamNames = innerParamNames;
  if (outerCorrelatedParams.length > 0) result.outerCorrelatedParams = outerCorrelatedParams;
  if (input.orderBy && input.orderBy.length > 0) result.orderBy = input.orderBy;
  if (input.limitNum !== undefined && input.limitNum !== null) result.limitNum = input.limitNum;
  if (input.offsetNum !== undefined && input.offsetNum !== null) result.offsetNum = input.offsetNum;
  if (input.distinct !== undefined) result.distinct = input.distinct;
  validateIrSubquery(result);
  return result;
}
