/**
 * Parse TypeScript CallExpression nodes as aggregate calls (SUM, COUNT, …)
 * for the compile-time transformer. Uses shared aggregate naming from `src/arrow`.
 */

import ts from "typescript";
import type { IrNode, IrAggregate } from "../ir/types.js";
import { AGGREGATE_FUNCS, toIrFuncName } from "../arrow/aggregates.js";
import { resolveMemberPath } from "./ts-member.js";
import { isIdentifierNamed } from "./ts-utils.js";

export interface TsAggregateParseResult {
  ir: IrAggregate;
  rawName: string;
}

export function parseTsAggregateCall(
  call: ts.CallExpression,
  paramNames: string[],
  resolveArg?: (expr: ts.Expression) => IrNode | null,
): TsAggregateParseResult | null {
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) return null;

  const rawName = callee.text;
  const funcName = toIrFuncName(rawName);
  if (!AGGREGATE_FUNCS.has(funcName)) return null;

  const { arg, distinct } = parseTsAggregateArg(
    call.arguments[0] as ts.Expression | undefined,
    paramNames,
    resolveArg,
  );
  const separator = parseTsAggregateSeparator(funcName, call);

  const ir: IrAggregate = {
    kind: "aggregate",
    func: funcName as IrAggregate["func"],
    arg,
    ...(distinct ? { distinct: true } : {}),
    ...(separator === undefined ? {} : { separator }),
  };
  return { ir, rawName };
}

function parseTsAggregateArg(
  argExpr: ts.Expression | undefined,
  paramNames: string[],
  resolveArg?: (expr: ts.Expression) => IrNode | null,
): { arg: IrNode | null; distinct: boolean } {
  if (!argExpr) return { arg: null, distinct: false };

  if (ts.isCallExpression(argExpr) && isIdentifierNamed(argExpr.expression, "distinct")) {
    return parseDistinctWrapperArg(argExpr, paramNames, resolveArg);
  }

  if (ts.isPropertyAccessExpression(argExpr)) {
    const resolved = resolveMemberPath(argExpr, paramNames);
    if (!resolved || resolved.path.length === 0) return { arg: null, distinct: false };
    return {
      arg: { kind: "member", param: resolved.param, path: resolved.path },
      distinct: false,
    };
  }

  if (resolveArg) {
    const arg = resolveArg(argExpr);
    return { arg, distinct: false };
  }

  return { arg: null, distinct: false };
}

function parseDistinctWrapperArg(
  distinctCall: ts.CallExpression,
  paramNames: string[],
  resolveArg?: (expr: ts.Expression) => IrNode | null,
): { arg: IrNode | null; distinct: boolean } {
  const inner = distinctCall.arguments[0] as ts.Expression | undefined;
  if (!inner) return { arg: null, distinct: false };
  if (ts.isPropertyAccessExpression(inner)) {
    const resolved = resolveMemberPath(inner, paramNames);
    if (!resolved || resolved.path.length === 0) return { arg: null, distinct: false };
    return {
      arg: { kind: "member", param: resolved.param, path: resolved.path },
      distinct: true,
    };
  }
  if (resolveArg) {
    const arg = resolveArg(inner);
    if (!arg) return { arg: null, distinct: false };
    return { arg, distinct: true };
  }
  return { arg: null, distinct: false };
}

function parseTsAggregateSeparator(funcName: string, call: ts.CallExpression): string | undefined {
  if (funcName !== "GROUP_CONCAT" && funcName !== "STRING_AGG") return undefined;
  const sepExpr = call.arguments[1] as ts.Expression | undefined;
  return sepExpr && ts.isStringLiteral(sepExpr) ? sepExpr.text : undefined;
}

// Re-export for tests/mocks that imported these from shared.
export { AGGREGATE_FUNCS, toIrFuncName } from "../arrow/aggregates.js";
