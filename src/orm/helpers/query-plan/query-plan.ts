/**
 * QueryPlanBuilder: converts a `QueryState` into a dialect-agnostic `QueryPlan`.
 *
 * # Where this fits
 *
 * The query pipeline has three layers:
 *
 * 1. **QueryBuilder** (`src/orm/query-builder.ts`) — accumulates user calls
 *    (`.where`, `.orderBy`, `.select`, …) into a `QueryState`. The state
 *    holds raw IR predicates, the three param bags (where/having/subquery),
 *    join hints, etc. — it's the user-facing input.
 * 2. **QueryPlanBuilder** (this file) — takes a `QueryState` and produces
 *    a `QueryPlan`: a flat, dialect-agnostic structure where every column
 *    reference has been resolved to a (table-alias, column-path) pair,
 *    every captured `QueryBuilder` has been inlined as a child plan,
 *    relations have been split into joins / fetches / projections, and
 *    the EXISTS / SUBQUERY / IN shapes have been pre-resolved.
 * 3. **QueryCompiler** (`src/dbs/<dialect>/query-compiler`) — walks the
 *    `QueryPlan`'s `Expr` tree to emit SQL strings + parameter arrays.
 *    The dialect never sees IR; the planner is the only IR consumer.
 *
 * # The five planning phases
 *
 * `build()` runs them in order:
 *
 * 1. **Alias scope** (`buildParamToAlias`).
 *    Decide which row-param names resolve to which SQL table aliases.
 *    Subqueries inherit their parent's mapping plus their own aliases.
 * 2. **Relation detection** (`detectRelations`). Decide which relations
 *    get joined into the main SELECT vs. kept for the relation pipeline,
 *    and pre-resolve any one-to-many EXISTS predicates. Delegated to
 *    relation helper classes for the heavy lifting.
 * 3. **Select classification** (`classifySelect`). Split the IR select
 *    into joined columns, fetched relations, and joined projections.
 *    Delegated to `SelectClassifier`.
 * 4. **IR → Expr conversion**. Pre-build captured child query plans, then
 *    convert where, having, orderBy, groupBy, and the select-list through
 *    `ExprBuilder` using only precomputed context.
 * 5. **Plan assembly**. Stamp everything onto a `QueryPlan` value object.
 *
 * # Subqueries
 *
 * Inline subqueries (correlated or otherwise) are planned before IR→Expr
 * conversion. The outer scope (current `paramToAlias` and the chosen
 * sub-alias) is threaded through so correlated column references in the
 * inner plan resolve against the outer table alias
 * — that's how `Author.query().select(a => ({ totalPosts:
 * Post.query().where(p => p.authorId === a.id).select(() => count()) }))`
 * compiles to a SQL subquery referencing `t0.id`.
 */

import { type IrSelectRelation, type JoinHint } from "../../../ir/types.js";
import type { RelationType } from "../../../entity/relations.js";
import type { AnyEntityClass } from "../../../entity/entity.js";
import type { QueryCompiler, QueryOperation } from "../../../dbs/types.js";
import {
  RelationJoinBuilder,
  RelationPathAliasBuilder,
  OneToManyExistsBuilder,
  type RelationJoinMeta,
  type OneToManyExistsMeta,
} from "../relations/relation-joins.js";
import type { QueryState } from "../../query-builder.js";
import type { Expr, GroupByItem, JoinSpec, OrderItem, SelectItem } from "../../expr.js";
import { ExprBuilder, type SubqueryPlans } from "./expr-builder.js";
import { SelectClassifier, EMPTY_CLASSIFIED, type ClassifiedSelect } from "./select-classifier.js";
import { QueryIrAnalyzer, type ExprIrAnalysis, type QueryIrAnalysis } from "./query-ir-analyzer.js";

/** Default name for the row-param when no explicit one is in scope. */
export const DEFAULT_ROW_PARAM = "u";

/** Alias of the main table for the top-level plan. Subquery plans pick
 *  fresh aliases (`t1`, `t2`, …) during the planner's subquery phase. */
const TABLE_ALIAS = "t0";

/**
 * Resolve a `QueryCompiler` from the QueryExecutor on a state. Throws if
 * the dialect isn't registered — used by the query-builder to look up
 * the dialect when it needs to compile SQL outside the planner path
 * (e.g. for `findById` shortcuts).
 */
export function getQueryCompilerOrThrow(state: QueryState<unknown>): QueryCompiler {
  return state.qe.dialect.queryCompiler;
}

// ─── plan types ───────────────────────────────────────────────────────────────

/**
 * Everything the relation-fetcher needs to execute a secondary load for
 * one relation. Built by `SelectClassifier.buildRelationFetchMeta` from
 * the relation definition + IR projection, then read by
 * `helpers/relations/relation-fetcher.ts`.
 *
 * Field layout depends on `relationType`:
 * - **many-to-one / one-to-one**: `fkColumns` are the parent's FK
 *   columns, `targetPkColumns` are the related entity's PK; secondary
 *   query is `SELECT * FROM target WHERE pk IN (...fkValues)`.
 * - **one-to-many**: `fkColumns` are on the *child*; `parentPkColumns`
 *   is stamped on after classification with the parent's PK columns;
 *   secondary query joins child.fk against parent.pk values.
 * - **many-to-many**: `junction` describes the link table; the fetcher
 *   joins through it.
 */
export interface RelationFetchMetadata {
  relationType: RelationType;
  relation: IrSelectRelation;
  fkColumns: string[];
  targetPkColumns: string[];
  targetEntity: AnyEntityClass;
  parentPkColumns?: string[];
  junction?: {
    table: string;
    foreignKey: string[];
    referenceKey: string[];
  };
}

/**
 * Recipe for reshaping flat JOIN-result columns back into nested
 * relation objects on the parent row. For example, if the parent SELECT
 * contains `t1.name AS author_name`, the assembler reads
 * `members: [{ alias: "author_name", subPath: "name" }]` and writes
 * `parent[outputKey].name = row.author_name`.
 *
 * Built by `SelectClassifier` and consumed by `RelationAssembler`.
 */
export interface JoinedProjection {
  relationKey: string;
  outputKey: string;
  /** Aliases in the result row that came from the JOIN, paired with their sub-path. */
  members: Array<{ alias: string; subPath: string }>;
}

/**
 * Dialect-agnostic execution plan. Produced by `QueryPlanBuilder` and
 * consumed by `QueryCompiler.compilePlan` (which produces SQL) plus the
 * relation pipeline (which uses the relation* fields to load and shape
 * fetched data after the main query runs).
 *
 * Splits into four logical groups:
 *
 * - **Operation + table**: `operation`, `tableName`, `tableAlias`,
 *   `columnNames` — what to do, on which table, under which alias.
 * - **SQL pieces**: `where`, `having`, `orderBy`, `groupBy`, `limitNum`,
 *   `offsetNum`, `selectItems`, `selectAll`, `joins` — the SQL body, all
 *   in resolved `Expr` form (no IR).
 * - **Relation pipeline**: `relationFetches`, `joinedProjections`,
 *   `skipLoadFor` — used after SQL execution to fetch and assemble
 *   related data.
 * - **Late-bound params**: `whereParams`, `havingParams` — original
 *   user-supplied bags; the dialect resolves `__param` sentinels against
 *   them at compile time.
 */
export interface QueryPlan {
  operation: QueryOperation;

  tableName: string;
  tableAlias: string;
  columnNames: string[];

  where: Expr | null;
  having: Expr | null;
  orderBy: OrderItem[];
  groupBy: GroupByItem[];
  limitNum: number | null;
  offsetNum: number | null;

  selectItems: SelectItem[];
  /** When true, no SELECT-list was specified; emit `<alias>.<col>` for every columnName. */
  selectAll: boolean;

  joins: JoinSpec[];

  relationFetches: RelationFetchMetadata[];
  joinedProjections: JoinedProjection[];
  skipLoadFor: Set<string>;

  whereParams: Record<string, unknown>;
  havingParams: Record<string, unknown>;
}

/**
 * Internal scope passed to `buildSub` when building a child plan for an
 * inline subquery. The child:
 *   - uses `subAlias` as its main table alias instead of the default
 *     `t0` (so it doesn't collide with the outer plan's aliases);
 *   - inherits the outer's `paramToAlias` so correlated row references
 *     resolve to the outer table.
 */
interface OuterScope {
  subAlias: string;
  paramToAlias: Record<string, string>;
}

/**
 * Output of `detectRelations`. `joins` are the relations the planner
 * wants to JOIN into the main SELECT (drives the SQL `JOIN` clauses and
 * the SELECT-list rewrite for joined relations). `oneToManyExists` is a
 * pre-resolved index of EXISTS metadata keyed by `"<rootParam>.<relKey>"`
 * — `ExprBuilder.convertExists` looks entries up here when converting
 * `IrExists` predicates so the SQL generation already has the inner
 * table, FK columns, and parent PK to use.
 */
interface RelationDetection {
  joins: RelationJoinMeta[];
  oneToManyExists: Record<string, OneToManyExistsMeta>;
}

// ─── public entry point ───────────────────────────────────────────────────────

/**
 * Plan a query against a `QueryState`. Use the static `build` entry
 * point — the constructor is private because every instance only ever
 * runs once (it holds per-build mutable state).
 */
export class QueryPlanBuilder {
  /**
   * Top-level entry point. Plans the given state for the given operation
   * (select / insert / update / delete) and returns a `QueryPlan`. The
   * plan is fully self-contained: no further IR walks happen downstream,
   * just dialect SQL emission and relation-pipeline execution.
   */
  static build(state: QueryState<unknown>, operation: QueryOperation): QueryPlan {
    const analysis = QueryIrAnalyzer.analyze(state, DEFAULT_ROW_PARAM);
    return new QueryPlanBuilder(state, operation, undefined, analysis).build();
  }

  /**
   * Internal entry point used by the planner's subquery phase to build a
   * child plan for an inline subquery. Receives the `OuterScope` so the
   * child plan can:
   *   - allocate its main alias from the outer's free-alias pool;
   *   - inherit the outer's `paramToAlias` for correlated references.
   *
   * Always built as a SELECT — inline subqueries can't be DML.
   */
  private static buildSubQuery(
    state: QueryState<unknown>,
    operation: QueryOperation,
    outer: OuterScope,
    analysis: QueryIrAnalysis,
  ): QueryPlan {
    return new QueryPlanBuilder(state, operation, outer, analysis).build();
  }

  private readonly state: QueryState<unknown>;
  private readonly operation: QueryOperation;
  private readonly outer?: OuterScope;
  private readonly tableAlias: string;
  private readonly analysis: QueryIrAnalysis;
  /** Cached row-param for this state. */
  private readonly rootParam: string;

  private constructor(
    state: QueryState<unknown>,
    operation: QueryOperation,
    outer: OuterScope | undefined,
    analysis: QueryIrAnalysis,
  ) {
    this.state = state;
    this.operation = operation;
    this.outer = outer;
    this.tableAlias = outer?.subAlias ?? TABLE_ALIAS;
    this.analysis = analysis;
    this.rootParam = analysis.rootParam;
  }

  /**
   * Drive the full planning pipeline for this state and produce a
   * `QueryPlan`. Phase order matters:
   *
   *   1. `buildParamToAlias` — needs to run first because every
   *      conversion downstream consults it.
   *   2. `detectRelations` — populates joins and one-to-many EXISTS
   *      metadata; the alias map for relation joins comes from
   *      `RelationPathAliasBuilder`.
   *   3. `classifySelect` — only relevant for SELECT operations; the
   *      `EMPTY_CLASSIFIED` sentinel is used otherwise.
   *   4. `buildSubqueryPlans` — pre-build inline child plans while the
   *      current scope is available.
   *   5. Construct an `ExprBuilder` with all the precomputed context.
   *   6. Convert where, having, orderBy, groupBy, selectItems through
   *      the ExprBuilder.
   *   7. Assemble the final `QueryPlan` value object.
   *
   * Mutation operations (insert/update/delete) skip the SELECT-only
   * fields (orderBy, groupBy, limit, offset, selectItems) — they're
   * left empty/null in the plan.
   */
  private build(): QueryPlan {
    const isSelect = this.operation.kind === "select";
    const hasFilter = this.operation.kind !== "insert" && this.operation.kind !== "insertMany";
    const paramToAlias = this.buildParamToAlias();
    const { joins, oneToManyExists } = this.detectRelations();
    const relationPathToAlias = new RelationPathAliasBuilder(
      joins,
      Object.keys(paramToAlias),
    ).build();
    const subqueryPlans = this.buildSubqueryPlans(paramToAlias, relationPathToAlias);

    const classified = isSelect ? this.classifySelect() : EMPTY_CLASSIFIED;

    const exprBuilder = new ExprBuilder(
      paramToAlias,
      relationPathToAlias,
      oneToManyExists,
      subqueryPlans,
      new Set(Object.keys(this.state.relations ?? {})),
    );

    const whereExpr =
      hasFilter && this.state.whereIr ? exprBuilder.convert(this.state.whereIr.node) : null;
    const havingExpr =
      isSelect && this.state.havingIr ? exprBuilder.convert(this.state.havingIr.node) : null;
    const orderBy = isSelect ? this.buildOrderBy(exprBuilder) : [];
    const groupBy = isSelect ? this.buildGroupBy(exprBuilder) : [];
    const selectItems = isSelect ? this.buildSelectItems(classified, exprBuilder) : [];

    const selectAll = !this.state.selectIr || this.state.selectIr.paths.length === 0;

    return {
      operation: this.operation,
      tableName: this.state.tableName,
      tableAlias: this.tableAlias,
      columnNames: this.state.columnNames,
      where: whereExpr,
      having: havingExpr,
      orderBy,
      groupBy,
      limitNum: isSelect ? this.state.limitNum : null,
      offsetNum: isSelect ? this.state.offsetNum : null,
      selectItems,
      selectAll: isSelect ? selectAll : false,
      joins: joins.map(toJoinSpec),
      relationFetches: classified.relationFetches,
      joinedProjections: classified.joinedProjections,
      skipLoadFor: classified.skipLoadFor,
      whereParams: this.state.whereParams,
      havingParams: this.state.havingParams,
    };
  }

  // ─── alias / paramToAlias ───────────────────────────────────────────────────

  /**
   * Build the row-param-name → table-alias map for this plan.
   *
   * Two inputs are merged:
   *
   *   1. **Referenced names** — every row-param mentioned in this state's
   *      where/orderBy/select, plus any names required by nested correlated
   *      subqueries, plus the default row-param so single-row predicates
   *      without an explicit param still work.
   *   2. **Outer scope** (only present for subquery builds) — the
   *      parent plan's `paramToAlias`. The parent's bindings are kept
   *      verbatim so correlated references resolve to the outer table
   *      alias.
   *
   * Each referenced name is mapped to *this builder's* table alias. For
   * subquery builds, the `localFilter` set restricts that mapping to
   * names the inner state actually binds locally — anything else stays
   * pointing at the outer alias, which is exactly what correlated
   * subqueries need.
   */
  private buildParamToAlias(): Record<string, string> {
    const referenced = new Set<string>([DEFAULT_ROW_PARAM]);
    for (const param of this.activeAnalysis().paramNames) referenced.add(param);
    for (const param of this.analysis.correlatedParamNames) referenced.add(param);

    const paramToAlias: Record<string, string> = { ...(this.outer?.paramToAlias ?? {}) };
    const localFilter = this.outer ? new Set(this.analysis.localParamNames) : null;
    for (const p of referenced) {
      if (localFilter && !localFilter.has(p)) continue;
      paramToAlias[p] = this.tableAlias;
    }
    return paramToAlias;
  }

  /**
   * Build every inline child query plan this state can reference during
   * expression conversion. `ExprBuilder` receives the finished map and only
   * swaps keys for plans; captured `QueryBuilder` values were already
   * separated into `state.subqueryParams` at the `QueryBuilder` boundary.
   */
  private buildSubqueryPlans(
    paramToAlias: Record<string, string>,
    relationPathToAlias: Record<string, string>,
  ): SubqueryPlans {
    const plans: SubqueryPlans = new Map();
    const subqueryRefs = this.activeAnalysis().subqueryRefs;
    const keys = Object.keys(subqueryRefs);
    if (keys.length === 0) return plans;

    const subAlias = this.pickSubqueryAlias(paramToAlias, relationPathToAlias);
    for (const key of keys) {
      const captured = this.state.subqueryParams[key];
      if (!captured) {
        throw new Error(`[typhex] subqueryRef "${key}" did not resolve to a captured subquery`);
      }
      const analysis = this.analysis.subqueries[key];
      if (!analysis) {
        throw new Error(`[typhex] subqueryRef "${key}" did not resolve to query IR analysis`);
      }

      plans.set(
        key,
        QueryPlanBuilder.buildSubQuery(
          captured.state,
          { kind: "select" },
          {
            subAlias,
            paramToAlias,
          },
          analysis,
        ),
      );
    }
    return plans;
  }

  private activeAnalysis(): ExprIrAnalysis {
    if (this.operation.kind === "select") return this.analysis.all;
    if (this.operation.kind === "insert" || this.operation.kind === "insertMany") {
      return EMPTY_EXPR_IR_ANALYSIS;
    }
    return mergeExprIrAnalysis(this.analysis.where, this.analysis.orderBy);
  }

  private pickSubqueryAlias(
    paramToAlias: Record<string, string>,
    relationPathToAlias: Record<string, string>,
  ): string {
    const used = new Set<string>([this.tableAlias]);
    for (const alias of Object.values(paramToAlias)) used.add(alias);
    for (const alias of Object.values(relationPathToAlias)) used.add(alias);
    return pickFreeAlias(used);
  }

  // ─── relation detection ─────────────────────────────────────────────────────

  /**
   * Detect joins and one-to-many EXISTS info for this state.
   *
   * Three short-circuits lift us out early with the empty result:
   *   1. **Subquery builds** (`this.outer` set) — child plans inherit
   *      relation info from the outer plan via the `paramToAlias`
   *      mapping; doing detection independently would double-join.
   *   2. **No relations on the entity** — nothing to detect.
   *   3. **Skippable mutation** (`canSkipRelationAnalysis`) — UPDATE/
   *      DELETE that don't reference any relation in their where/orderBy/
   *      joinHints don't need the analysis.
   *
   * Otherwise it delegates to relation helper classes: one chooses which
   * relations to JOIN, the other pre-resolves EXISTS metadata for `.some()`/
   * `.every()` predicates.
   */
  private detectRelations(): RelationDetection {
    if (this.outer) return EMPTY_RELATION_DETECTION;

    const { relations, resolveRelationTarget } = this.state;
    if (!relations || Object.keys(relations).length === 0 || !resolveRelationTarget) {
      return EMPTY_RELATION_DETECTION;
    }
    if (this.canSkipRelationAnalysis()) return EMPTY_RELATION_DETECTION;

    const pkColumns = this.state.pkColumns;

    return {
      joins: new RelationJoinBuilder(
        {
          relations,
          tableName: this.state.tableName,
          columnNames: this.state.columnNames,
          pkColumns,
          resolveTarget: resolveRelationTarget,
        },
        this.analysis.joinRelationKeys,
        this.state.joinHints,
      ).build(),
      oneToManyExists: new OneToManyExistsBuilder(
        [...this.analysis.where.existsNodes, ...this.analysis.having.existsNodes],
        relations,
        this.rootParam,
        pkColumns,
        resolveRelationTarget,
        this.analysis.localParamNames,
      ).build(),
    };
  }

  /**
   * True for mutations that have no need for relation detection:
   *   - SELECT operations always need detection (returns false).
   *   - Any explicit `.innerJoin` / `.leftJoin` / etc. forces detection.
   *   - Otherwise, we can skip if neither the where predicate nor any
   *     orderBy expression references a relation key.
   */
  private canSkipRelationAnalysis(): boolean {
    if (this.operation.kind === "select") return false;
    if (this.operation.kind === "insert" || this.operation.kind === "insertMany") return true;
    if (this.state.joinHints?.length) return false;
    const relations = this.state.relations;
    if (!relations) return true;
    return this.analysis.joinRelationKeys.size === 0;
  }

  // ─── select classification ──────────────────────────────────────────────────

  /**
   * Classify the SELECT-list against the relation map. Empty fast-path
   * if there's no select IR or no relations to consult. Otherwise:
   *
   *   1. Compute the `reusableJoinKeys` set — relations the planner has
   *      decided to JOIN (so their member references stay in the SELECT
   *      list rather than triggering a separate fetch).
   *   2. Resolve the parent's PK columns. Used by the
   *      classifier for to-many `parentPkColumns` and for the missing-
   *      key-column check.
   *   3. Construct a `SelectClassifier` with those inputs and run it.
   *
   * The result drives the rest of the build: `buildSelectItems` reads
   * `columnPaths`/`columnAliases`, the relation pipeline reads
   * `relationFetches`/`joinedProjections`/`skipLoadFor`.
   */
  private classifySelect(): ClassifiedSelect {
    const select = this.state.selectIr;
    const relations = this.state.relations;
    if (!select || !relations) return EMPTY_CLASSIFIED;

    const pkColumns = this.state.pkColumns;

    return new SelectClassifier(
      select,
      relations,
      pkColumns,
      this.analysis.reusableJoinKeys,
    ).classify();
  }

  // ─── select-list / orderBy / groupBy ────────────────────────────────────────

  /**
   * Build the ordered `SelectItem[]` that the dialect will turn into
   * the SQL `SELECT` list. Four sources, in order:
   *
   *   1. **Column paths** — either the classifier's reshape (if relation
   *      analysis ran) or the IR's own `select.paths`. Each is resolved
   *      to an `ExprColumn` via `exprBuilder.resolveColumn`. Empty paths
   *      (rare — only when relation rewrite consumed the whole path)
   *      omit the alias since the column itself is the alias.
   *   2. **Rest spread** — when the user wrote `({ ...u, ... })` in their
   *      select body, the IR sets `select.rest` and we need to add every
   *      table column not already in the explicit list.
   *   3. **Aggregates** — `select.aggregates` carries IR aggregate nodes
   *      (e.g. `count(p.id) as total`); each becomes an `ExprAggregate`.
   *   4. **Subqueries** — `select.subqueries` carries select-list inline
   *      `Entity.query()...` chains; each becomes an inline subquery via
   *      the pre-built subquery plan map.
   */
  private buildSelectItems(classified: ClassifiedSelect, exprBuilder: ExprBuilder): SelectItem[] {
    const select = this.state.selectIr;
    if (!select) return [];

    const items: SelectItem[] = [];
    const paths = classified.columnPaths ?? select.paths;
    const aliases = classified.columnAliases ?? select.aliases ?? [];
    const rootParam = select.param;

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const expr = exprBuilder.resolveColumn(rootParam, path);
      items.push(path.length === 0 ? { expr } : { expr, alias: aliases[i] });
    }

    if (select.rest) {
      const explicitCols = new Set(paths.map((p) => p[0]));
      for (const c of this.state.columnNames) {
        if (!explicitCols.has(c)) {
          items.push({ expr: { kind: "column", alias: this.tableAlias, column: [c] } });
        }
      }
    }

    for (const agg of select.aggregates ?? []) {
      items.push({ expr: exprBuilder.convertAggregate(agg), alias: agg.alias });
    }

    for (const entry of select.subqueries ?? []) {
      items.push({ expr: exprBuilder.convertSubqueryRef(entry.subquery), alias: entry.alias });
    }

    return items;
  }

  /** Build the `OrderItem[]` for the ORDER BY clause. */
  private buildOrderBy(exprBuilder: ExprBuilder): OrderItem[] {
    return this.state.orderBy.map((o) => ({
      expr:
        o.expr.kind === "member"
          ? exprBuilder.resolveColumn(o.expr.param, o.expr.path)
          : exprBuilder.convert(o.expr),
      direction: o.direction,
    }));
  }

  /**
   * Build the `GroupByItem[]` for the GROUP BY clause. Numeric entries
   * are positional column references (e.g. `GROUP BY 1`); array entries
   * are member paths resolved via `resolveColumn`. Empty path arrays
   * throw — the IR shouldn't produce them, but the check turns a silent
   * "GROUP BY t0." render bug into a loud error.
   *
   * The row-param defaults to the select's own param, falling back to
   * `DEFAULT_ROW_PARAM` for groupBy without a preceding select.
   */
  private buildGroupBy(exprBuilder: ExprBuilder): GroupByItem[] {
    const entries = this.state.selectIr?.groupBy ?? [];
    const param = this.state.selectIr?.param ?? DEFAULT_ROW_PARAM;
    return entries.map((entry) => {
      if (typeof entry === "number") return { kind: "index", index: entry };
      if (entry.length === 0) throw new Error("[typhex] GROUP BY path cannot be empty");
      return exprBuilder.resolveColumn(param, entry);
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Sentinel for `detectRelations` short-circuits. Identity-shared so the
 *  three early-return paths don't allocate a fresh object per skip. */
const EMPTY_RELATION_DETECTION: RelationDetection = {
  joins: [],
  oneToManyExists: {},
};

const EMPTY_EXPR_IR_ANALYSIS: ExprIrAnalysis = {
  paramNames: new Set(),
  relationKeys: new Set(),
  subqueryRefs: {},
  existsNodes: [],
};

function mergeExprIrAnalysis(...items: ExprIrAnalysis[]): ExprIrAnalysis {
  const out: ExprIrAnalysis = {
    paramNames: new Set(),
    relationKeys: new Set(),
    subqueryRefs: {},
    existsNodes: [],
  };
  for (const item of items) {
    for (const param of item.paramNames) out.paramNames.add(param);
    for (const key of item.relationKeys) out.relationKeys.add(key);
    Object.assign(out.subqueryRefs, item.subqueryRefs);
    out.existsNodes.push(...item.existsNodes);
  }
  return out;
}

/**
 * Pick the lowest-numbered `tN` alias not already taken. Sibling
 * subqueries can share the same alias because each compiles to an
 * isolated parenthesized SELECT.
 */
function pickFreeAlias(used: Set<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `t${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Project a `RelationJoinMeta` (used internally during relation-detection
 * to carry the planning-time fields) onto the public `JoinSpec` shape
 * that the dialect consumes. The dialect has no business knowing
 * planning-only fields, so this strip-down is the boundary.
 */
function toJoinSpec(j: RelationJoinMeta): JoinSpec {
  return {
    relationKey: j.relationKey,
    alias: j.alias,
    targetTable: j.targetTable,
    targetPkColumns: j.targetPkColumns,
    foreignKeys: j.foreignKeys,
    relType: j.relType,
    joinType: j.joinType,
  };
}

/** Re-export so the legacy `import type { JoinHint } from "./query-plan"` path
 *  keeps working for any consumer that still does it. */
export type { JoinHint };
