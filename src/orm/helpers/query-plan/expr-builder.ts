/**
 * IR → Expr conversion.
 *
 * The planner-side IR (`src/ir/types.ts`) is the parser's output: arrow
 * predicates and select bodies turned into a tree of nodes that still
 * reference user-facing names like the row parameter (`u`, `c`, …) and
 * relation keys (`u.author`). The runtime Expr model (`src/orm/expr.ts`)
 * is what the dialect compiles to SQL: every column reference has been
 * resolved to a (table-alias, column-path) pair, every captured
 * `QueryBuilder` has been inlined as a child `QueryPlan`, and every
 * one-to-many `EXISTS` has been pre-resolved to its target table and
 * join keys.
 *
 * `ExprBuilder` performs that conversion. The planner constructs it once
 * per plan with precomputed context: row-param aliases, relation join
 * aliases, one-to-many EXISTS metadata, and already-built child subquery
 * plans. It does not build child plans itself; when conversion reaches a
 * subquery placeholder, it only swaps in the `QueryPlan` the planner
 * prepared earlier.
 */

import type { IrNode, IrSubqueryRef, IrAggregate } from "../../../ir/types.js";
import type { Expr, ExprColumn, ExprAggregate } from "../../expr.js";
import type { OneToManyExistsMeta } from "../relations/relation-joins.js";
import type { QueryPlan } from "./query-plan.js";

export type SubqueryPlans = Map<string, QueryPlan>;

/**
 * Converts IR nodes to runtime `Expr` against a precomputed alias context.
 *
 * Constructor inputs:
 * - `paramToAlias` — maps every row-param name in scope (including
 *   outer-correlated ones) to its SQL table alias. Built by the planner's
 *   `buildParamToAlias` phase.
 * - `relationPathToAlias` — maps `"<param>.<relKey>"` to the join alias
 *   the planner allocated for that relation. Drives the column-path
 *   rewrite in `resolveColumn` (a member access through a joined relation
 *   becomes a column reference on the join's alias).
 * - `oneToManyExists` — pre-resolved EXISTS metadata keyed by
 *   `"<rootParam>.<relationKey>"`. Lets `convertExists` emit a fully
 *   structured `ExprExists` without redoing the relation lookup.
 * - `subqueryPlans` — child plans keyed by the runtime param/subquery
 *   placeholder names that reference captured `QueryBuilder`s.
 */
export class ExprBuilder {
  constructor(
    private readonly paramToAlias: Record<string, string>,
    private readonly relationPathToAlias: Record<string, string>,
    private readonly oneToManyExists: Record<string, OneToManyExistsMeta>,
    private readonly subqueryPlans: SubqueryPlans,
    private readonly relationKeys: Set<string> = new Set(),
    private readonly cteNames: Set<string> = new Set(),
  ) {}

  /**
   * Recursively convert any IR node to an `Expr`.
   *
   * `scope` is the row-param-to-table-alias mapping in effect for this
   * conversion. It defaults to the builder's `paramToAlias` (the top-level
   * scope of the plan being built). `convertExists` augments and re-passes
   * it: when an `EXISTS` predicate binds a fresh inner row-param (e.g.
   * `d.employees.some(e => e.name === "Alice")` binds `e`), the recursive
   * call uses `{ ...scope, [innerParam]: innerAlias }` so the inner
   * predicate's `e.name` resolves against the inner-relation table alias
   * rather than the outer row's.
   *
   * Throws on unknown node kinds — the IR types are a closed union, so
   * hitting the default branch means a future-added kind wasn't handled.
   */
  convert(
    node: IrNode,
    scope: Record<string, string> = this.paramToAlias,
    inlineParams?: Record<string, unknown>,
  ): Expr {
    switch (node.kind) {
      case "binary":
        return {
          kind: "binary",
          op: node.op,
          left: this.convert(node.left, scope, inlineParams),
          right: this.convert(node.right, scope, inlineParams),
        };
      case "unary":
        return { kind: "unary", op: node.op, operand: this.convert(node.operand, scope, inlineParams) };
      case "member":
        return this.resolveColumn(node.param, node.path, scope);
      case "const":
        return { kind: "const", value: node.value };
      case "param":
        return this.resolveParamRef(node.key, inlineParams);
      case "in":
        return this.convertIn(node, scope, inlineParams);
      case "call":
        return {
          kind: "call",
          method: node.method,
          receiver: this.convert(node.receiver, scope, inlineParams),
          args: node.args.map((a) => this.convert(a, scope, inlineParams)),
        };
      case "exists":
        return this.convertExists(node, scope, inlineParams);
      case "subqueryRef":
        return this.convertSubqueryRef(node);
      case "aggregate":
        return this.convertAggregate(node, scope, inlineParams);
      case "case":
        return {
          kind: "case",
          branches: node.branches.map((b) => ({
            when: this.convert(b.when, scope, inlineParams),
            then: this.convert(b.then, scope, inlineParams),
          })),
          ...(node.else !== undefined ? { else: this.convert(node.else, scope, inlineParams) } : {}),
        };
      default:
        throw new Error(`[typhex] Unknown IR node kind: ${(node as { kind: string }).kind}`);
    }
  }

  /**
   * Resolve `param.path` (an IR member reference) to a (alias, column-path)
   * pair the dialect can render directly.
   *
   * Resolution proceeds in two steps:
   *
   * 1. **Alias lookup.** The starting alias is `scope[param]`. The planner
   *    builds that scope before conversion, including local and correlated
   *    row params.
   *
   * 2. **Relation rewrite.** If `path[0]` names a relation that has been
   *    joined into the query (`relationPathToAlias` has an entry for
   *    `"<param>.<path[0]>"`), the alias is replaced with the join's
   *    alias and the leading segment is dropped from the path. Example:
   *    `u.author.name` with `relationPathToAlias["u.author"] = "t1"`
   *    rewrites to `(alias: "t1", column: ["name"])`.
   *
   * The returned `ExprColumn.column` is a path array: empty means the
   * alias itself (rare — only when relation rewrite consumed the entire
   * path), single element is a leaf column, multiple elements is a
   * dotted path (rare; preserved for forward compatibility).
   */
  resolveColumn(
    param: string,
    path: string[],
    scope: Record<string, string> = this.paramToAlias,
  ): ExprColumn {
    this.assertColumnPath(path);

    if (path.length > 0 && this.cteNames.has(path[0])) {
      return { kind: "column", alias: path[0], column: path.slice(1) };
    }

    let alias = scope[param];
    let p = path;
    const relAlias = path.length > 1 ? this.relationPathToAlias[`${param}.${path[0]}`] : undefined;
    if (relAlias) {
      alias = relAlias;
      p = path.slice(1);
    }
    return { kind: "column", alias, column: p };
  }

  private assertColumnPath(path: string[]): void {
    const key = path[0];
    if (!key) return;
    if (this.cteNames.has(key)) {
      if (path.length === 1) {
        throw new Error(`[typhex] CTE "${key}" must reference a column`);
      }
      return;
    }
    if (path.length === 1 && this.relationKeys.has(key)) {
      throw new Error(`[typhex] relation "${key}" must reference a column`);
    }
  }

  /**
   * Convert an `IrAggregate` (e.g. `count(u.id)`, `sum(p.price)`) to an
   * `ExprAggregate`. The argument expression — when present — is converted
   * recursively so nested member paths resolve through the same alias
   * scope. `null` arg means `COUNT(*)` style.
   *
   * Public so the planner's `buildSelectItems` can convert select-list
   * aggregates directly without a wrapping `IrNode` that would otherwise
   * route through `convert`.
   */
  convertAggregate(
    agg: IrAggregate,
    scope: Record<string, string> = this.paramToAlias,
    inlineParams?: Record<string, unknown>,
  ): ExprAggregate {
    return {
      kind: "aggregate",
      func: agg.func,
      arg: agg.arg ? this.convert(agg.arg, scope, inlineParams) : null,
      alias: agg.alias,
      distinct: agg.distinct,
      separator: agg.separator,
    };
  }

  /**
   * Convert an `IrSubqueryRef` (a transformer-emitted placeholder pointing
   * at a captured `QueryBuilder` in the param bags) to an `ExprSubquery`
   * by looking up the child plan the planner already built.
   * Public so `buildSelectItems` can use it for select-list subqueries
   * (`Entity.query()....` projected as a column value).
   */
  convertSubqueryRef(ref: IrSubqueryRef): Expr {
    return { kind: "subquery", plan: this.getSubqueryPlan(ref.key) };
  }

  /**
   * Resolve an `IrParam` (free variable referenced by name from a runtime-
   * parsed predicate). Captured subqueries are represented as
   * `IrSubqueryRef`, so params always stay late-bound.
   */
  private resolveParamRef(key: string, inlineParams: Record<string, unknown> | undefined): Expr {
    if (inlineParams === undefined) {
      return { kind: "param", name: key };
    }
    if (key in inlineParams) {
      return { kind: "const", value: this.requireInlineLiteral(key, inlineParams[key]) };
    }
    throw new Error(`[typhex] inline param "${key}" not provided`);
  }

  private requireInlineLiteral(key: string, value: unknown): unknown {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    throw new Error(`[typhex] Cannot inline SQL literal "${key}" of type ${typeof value}`);
  }

  /**
   * Convert `<expr> IN <rhs>` (or `NOT IN`). The right-hand side has three
   * legal IR shapes that map to three different `ExprInRhs` shapes:
   *
   * - `IrConst` array → `{ kind: "values", values }` — inline literal list,
   *   compiled to `(?, ?, ?)` placeholders.
   * - `IrParam` → a late-bound param reference. It expands at execution
   *   time when the dialect resolves `__param` sentinels.
   * - `IrSubqueryRef` → a pre-built inline subquery plan.
   *
   * Anything else throws — IN's right side is a closed union by spec.
   */
  private convertIn(
    node: IrNode & { kind: "in" },
    scope: Record<string, string>,
    inlineParams: Record<string, unknown> | undefined,
  ): Expr {
    const left = this.convert(node.left, scope, inlineParams);
    const { negated } = node;
    const right = node.right;

    if (right.kind === "const" && Array.isArray(right.value)) {
      return { kind: "in", left, right: { kind: "values", values: right.value }, negated };
    }
    if (right.kind === "param") {
      return { kind: "in", left, right: { kind: "param", name: right.key }, negated };
    }
    if (right.kind === "subqueryRef") {
      return {
        kind: "in",
        left,
        right: { kind: "subquery", plan: this.subqueryPlans.get(right.key)! },
        negated,
      };
    }
    throw new Error("[typhex] IN right side must be const array, param, or subqueryRef");
  }

  /**
   * Convert an `IrExists` (a one-to-many `EXISTS (...)` subquery).
   *
   * The relation lookup was done up-front by the planner's
   * `OneToManyExistsBuilder`, which produced `oneToManyExists` keyed by
   * `"<rootParam>.<relationKey>"`. We just look up the entry and stamp it
   * onto the runtime `ExprExists`.
   *
   * Two scope details worth noting:
   *
   * 1. **outerAlias.** This is the alias the EXISTS predicate joins
   *    against (typically the main table). Resolving via
   *    `scope[node.rootParam]` is what makes nested EXISTS work: when an
   *    EXISTS is itself inside another EXISTS' inner predicate, the
   *    inner-most rootParam is actually the parent EXISTS' bound row,
   *    and `scope` will have been augmented to map it to the parent's
   *    inner alias.
   *
   * 2. **innerScope.** Augmenting with `[innerParam]: info.alias` is what
   *    lets the inner predicate's column references (`e.name` in
   *    `.some(e => e.name === ...)`) resolve to the inner relation's
   *    table alias rather than the outer row's.
   */
  private convertExists(
    node: IrNode & { kind: "exists" },
    scope: Record<string, string>,
    inlineParams: Record<string, unknown> | undefined,
  ): Expr {
    const key = `${node.rootParam}.${node.relationKey}`;
    const meta = this.oneToManyExists[key];
    if (!meta) {
      throw new Error(
        `[typhex] EXISTS predicate for relation "${node.relationKey}" could not be planned`,
      );
    }
    const innerScope = { ...scope, [node.innerParam]: meta.alias };
    return {
      kind: "exists",
      negated: node.negated,
      outerAlias: scope[node.rootParam],
      innerAlias: meta.alias,
      targetTable: meta.targetTable,
      fkColumns: meta.fkColumns,
      mainPk: meta.mainPk,
      predicate: this.convert(node.innerWhere, innerScope, inlineParams),
    };
  }

  private getSubqueryPlan(key: string): QueryPlan {
    return this.subqueryPlans.get(key)!;
  }
}
