import type { IrNode, IrOrderBy, IrSelect } from "../../../ir/types.js";
import { rewriteIr } from "../../../ir/types.js";

export function inlineParamsInIr(node: IrNode, paramValues: Record<string, unknown>): IrNode {
  return rewriteIr(node, (n) => {
    if (n.kind !== "param") return n;
    if (!(n.key in paramValues)) {
      throw new Error(`[typhex] inline param "${n.key}" not provided`);
    }
    const value = paramValues[n.key];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error(`[typhex] Cannot inline SQL literal of type ${typeof value}`);
    }
    return { kind: "const", value };
  });
}

export function inlineSelectParams(
  select: IrSelect | null,
  paramValues: Record<string, unknown> | undefined,
): IrSelect | null {
  if (!select) return select;
  if (paramValues === undefined) return select;
  if (!select.aggregates && !select.expressions) return select;
  const sub = (n: IrNode): IrNode => inlineParamsInIr(n, paramValues);
  return {
    ...select,
    ...(select.aggregates
      ? { aggregates: select.aggregates.map((a) => ({ ...a, arg: a.arg ? sub(a.arg) : null })) }
      : {}),
    ...(select.expressions
      ? { expressions: select.expressions.map((e) => ({ ...e, expr: sub(e.expr) })) }
      : {}),
  };
}

export function inlineOrderByParams(
  orderBy: IrOrderBy[],
  paramValues: Record<string, unknown> | undefined,
): IrOrderBy[] {
  if (!paramValues) return orderBy;
  return orderBy.map((o) => ({ ...o, expr: inlineParamsInIr(o.expr, paramValues) }));
}
