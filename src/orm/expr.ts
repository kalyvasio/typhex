/**
 * Runtime expression model — what the dialect compiles to SQL.
 *
 * Independent of the parser-side IR (`src/ir/types.ts`). The QueryPlanBuilder
 * converts IR to Expr once during planning, resolving member paths to alias +
 * column pairs and inlining subquery plans. The dialect walks Expr; it never
 * imports from `src/ir/`.
 */

import type { JoinType } from "../ir/types.js";
import type { QueryPlan } from "./helpers/query-plan/query-plan.js";

export type BinaryOp = "&&" | "||" | "===" | "!==" | "==" | "!=" | ">" | ">=" | "<" | "<=";

export type AggregateFn =
  | "SUM"
  | "AVG"
  | "MIN"
  | "MAX"
  | "COUNT"
  | "GROUP_CONCAT"
  | "STRING_AGG"
  | "ARRAY_AGG"
  | "JSON_AGG";

export type Expr =
  | ExprBinary
  | ExprUnary
  | ExprColumn
  | ExprConst
  | ExprParam
  | ExprIn
  | ExprCall
  | ExprAggregate
  | ExprExists
  | ExprSubquery;

export interface ExprBinary {
  kind: "binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface ExprUnary {
  kind: "unary";
  op: "!";
  operand: Expr;
}

/** Resolved column reference. `alias` is the SQL table alias (e.g. "t0", "t1").
 *  `column` is the column path: empty array means the alias itself (rare —
 *  used when a member path was fully consumed by relation rewrite); a single
 *  element is a leaf column; multiple elements are a multi-segment path
 *  rendered as quoted dotted segments. */
export interface ExprColumn {
  kind: "column";
  alias: string;
  column: string[];
}

export interface ExprConst {
  kind: "const";
  value: unknown;
}

/** Late-bound parameter — resolved at runtime against the plan's param bags. */
export interface ExprParam {
  kind: "param";
  name: string;
}

export interface ExprIn {
  kind: "in";
  left: Expr;
  right: ExprInRhs;
  negated?: boolean;
}

export type ExprInRhs =
  | { kind: "values"; values: unknown[] }
  | { kind: "param"; name: string }
  | { kind: "subquery"; plan: QueryPlan };

export interface ExprCall {
  kind: "call";
  method: string;
  receiver: Expr;
  args: Expr[];
}

export interface ExprAggregate {
  kind: "aggregate";
  func: AggregateFn;
  arg: Expr | null;
  alias?: string;
  distinct?: boolean;
  separator?: string;
}

/** Pre-resolved EXISTS subquery for one-to-many filters. The planner has
 *  already chosen `outerAlias`/`innerAlias` and resolved the predicate's
 *  inner row-param to `innerAlias`. */
export interface ExprExists {
  kind: "exists";
  negated?: boolean;
  outerAlias: string;
  innerAlias: string;
  targetTable: string;
  fkColumns: string[];
  mainPk: string[];
  predicate: Expr;
}

/** Embedded subquery — fully built child plan. */
export interface ExprSubquery {
  kind: "subquery";
  plan: QueryPlan;
}

/** A SELECT-list item. `alias` is optional — when undefined no AS clause is emitted. */
export interface SelectItem {
  expr: Expr;
  alias?: string;
}

export type OrderDirection = "asc" | "desc";

export interface OrderItem {
  expr: Expr;
  direction: OrderDirection;
}

export type GroupByItem = ExprColumn | { kind: "index"; index: number };

export interface JoinSpec {
  relationKey: string;
  alias: string;
  targetTable: string;
  targetPkColumns: string[];
  foreignKeys: string[];
  relType: "many-to-one" | "one-to-one";
  joinType: JoinType;
}
