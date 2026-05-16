/**
 * Backwards-compatible exports for shared query compilation helpers.
 *
 * The implementation now lives on QueryCompiler classes.
 */

import { getQueryCompiler } from "./index.js";
import type { DialectImpl, QueryCompiler } from "./types.js";
import type { Expr, ExprAggregate, OrderItem, SelectItem } from "../orm/expr.js";
import {
  compileAggregate,
  compileAggregateArg,
  compileConcatAggregate,
  compileGroupBy,
  compileStandardAggregate,
  JOIN_SQL_KEYWORDS,
  quoteId,
} from "./query-compiler.js";

export {
  compileAggregate,
  compileAggregateArg,
  compileConcatAggregate,
  compileGroupBy,
  compileStandardAggregate,
  JOIN_SQL_KEYWORDS,
  quoteId,
};

type CompilerLike = QueryCompiler | DialectImpl;
type CompilerInternals = QueryCompiler & {
  makeCompileNode(): (node: Expr, params: unknown[]) => string;
  compileWhereExpr(node: Expr | null): { sql: string; params: unknown[] };
  compileOrderByExpr(orders: OrderItem[]): { sql: string; params: unknown[] };
  compileSelectListExpr(
    items: SelectItem[],
    selectAll: boolean,
    tableAlias: string,
    columnNames: string[],
    compileAggFn?: (
      agg: ExprAggregate,
      compileNodeFn: (node: Expr, params: unknown[]) => string,
      params: unknown[],
    ) => string,
  ): { sql: string; params: unknown[] };
};

function resolveCompiler(input: CompilerLike): CompilerInternals {
  if ("compilePlan" in input) return input as CompilerInternals;
  return getQueryCompiler(input.name) as CompilerInternals;
}

/** @internal */
export function makeCompileNode(input: CompilerLike) {
  return resolveCompiler(input).makeCompileNode();
}

/** @internal */
export function compileWhereExpr(
  node: Expr | null,
  input: CompilerLike,
): { sql: string; params: unknown[] } {
  return resolveCompiler(input).compileWhereExpr(node);
}

/** @internal */
export function compileOrderByExpr(
  orders: OrderItem[],
  input: CompilerLike,
): { sql: string; params: unknown[] } {
  return resolveCompiler(input).compileOrderByExpr(orders);
}

/** @internal */
export function compileSelectListExpr(
  items: SelectItem[],
  selectAll: boolean,
  tableAlias: string,
  columnNames: string[],
  input: CompilerLike,
  compileAggFn?: (
    agg: ExprAggregate,
    compileNodeFn: (node: Expr, params: unknown[]) => string,
    params: unknown[],
  ) => string,
): { sql: string; params: unknown[] } {
  return resolveCompiler(input).compileSelectListExpr(
    items,
    selectAll,
    tableAlias,
    columnNames,
    compileAggFn,
  );
}
