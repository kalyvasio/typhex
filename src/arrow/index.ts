/**
 * Shared arrow-expression language rules and semantic IR builders. The
 * parser and transformer keep their AST-specific traversal in their own
 * modules and converge here only after child expressions are resolved.
 */

import type { IrCase, IrExists, IrNode } from "../ir/types.js";

export {
  DEFAULT_ROW_PARAM,
  ALLOWED_METHODS,
  RELATION_QUERY_METHODS,
  ACORN_BINARY_OPS,
} from "./constants.js";
export {
  AGGREGATE_FUNCS,
  buildIrAggregate,
  getAggregateSeparatorArgIndex,
  isAggregateFunc,
  toIrAggregateFunc,
  toIrFuncName,
} from "./aggregates.js";

export function buildIrCase(when: IrNode, then: IrNode, alternate: IrNode): IrCase {
  if (alternate.kind === "case") {
    return {
      kind: "case",
      branches: [{ when, then }, ...alternate.branches],
      ...(alternate.else !== undefined ? { else: alternate.else } : {}),
    };
  }
  return { kind: "case", branches: [{ when, then }], else: alternate };
}

export function buildIrExists(
  quantifier: "some" | "every",
  rootParam: string,
  relationKey: string,
  innerParam: string,
  innerWhere: IrNode,
): IrExists {
  return {
    kind: "exists",
    ...(quantifier === "every" ? { negated: true } : {}),
    rootParam,
    relationKey,
    innerParam,
    innerWhere,
  };
}
