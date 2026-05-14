/**
 * Test helpers for constructing Expr / QueryPlan values directly.
 * Tests use these to build queries without going through IR.
 */

import type { Expr, ExprColumn, OrderItem, SelectItem } from "../../src/orm/expr.js";
import type { QueryPlan } from "../../src/orm/helpers/query-plan/query-plan.js";

/** Build a column Expr (alias-resolved). */
export function col(alias: string, column: string): ExprColumn {
  return { kind: "column", alias, column: [column] };
}

/** Build a const Expr. */
export function konst(value: unknown): Expr {
  return { kind: "const", value };
}

/** Build a binary comparison Expr. */
export function eq(left: Expr, right: Expr): Expr {
  return { kind: "binary", op: "===", left, right };
}

export function bin(
  op: "&&" | "||" | "===" | "!==" | "==" | "!=" | ">" | ">=" | "<" | "<=",
  left: Expr,
  right: Expr,
): Expr {
  return { kind: "binary", op, left, right };
}

/** Build a SELECT-list QueryPlan with sensible defaults. */
export function selectPlan(opts: {
  tableName?: string;
  tableAlias?: string;
  columnNames?: string[];
  where?: Expr | null;
  having?: Expr | null;
  orderBy?: OrderItem[];
  groupBy?: QueryPlan["groupBy"];
  limitNum?: number | null;
  offsetNum?: number | null;
  selectItems?: SelectItem[];
  selectAll?: boolean;
  joins?: QueryPlan["joins"];
  whereParams?: Record<string, unknown>;
  havingParams?: Record<string, unknown>;
}): QueryPlan {
  return {
    operation: { kind: "select" },
    tableName: opts.tableName ?? "posts",
    tableAlias: opts.tableAlias ?? "t1",
    columnNames: opts.columnNames ?? [],
    where: opts.where ?? null,
    having: opts.having ?? null,
    orderBy: opts.orderBy ?? [],
    groupBy: opts.groupBy ?? [],
    limitNum: opts.limitNum ?? null,
    offsetNum: opts.offsetNum ?? null,
    selectItems: opts.selectItems ?? [],
    selectAll: opts.selectAll ?? false,
    joins: opts.joins ?? [],
    relationFetches: [],
    joinedProjections: [],
    skipLoadFor: new Set(),
    whereParams: opts.whereParams ?? {},
    havingParams: opts.havingParams ?? {},
  };
}

/** Common subquery plan: SELECT id FROM posts AS t1 WHERE active = true */
export const countPostsSelect: SelectItem[] = [
  {
    expr: {
      kind: "aggregate",
      func: "COUNT",
      arg: null,
    },
  },
];
