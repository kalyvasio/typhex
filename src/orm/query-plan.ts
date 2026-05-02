/**
 * QueryPlanBuilder: converts a QueryState into a dialect-agnostic QueryPlan.
 *
 * Every IR walk happens here exactly once:
 *   - relation join detection (many-to-one / one-to-one)
 *   - one-to-many EXISTS detection
 *   - select path classification (joined columns, fetched relations, joined projections)
 *   - IR → Expr conversion (member paths → alias+column, subqueryRef → embedded plan)
 *
 * The planner has no `dialect` reference. It produces a QueryPlan whose
 * expression fields use `Expr` (src/orm/expr.ts) and whose relation pipeline
 * uses pre-extracted classifications. The dialect walks Expr to emit SQL; the
 * relation pipeline reads `relationFetches` / `joinedProjections` / `skipLoadFor`.
 */

import {
  collectParamNamesFromWhere,
  type IrNode,
  type IrSelect,
  type IrSelectRelation,
  type IrAggregate,
  type IrSubqueryRef,
  type IrMember,
  type JoinHint,
} from "../ir/types.js";
import type {
  RelationsMap,
  RelationDef,
  RelationOptions,
  JunctionOptions,
  RelationType,
} from "../entity/relations.js";
import { toArray } from "../utils.js";
import { getPkColumnsFromSchema, type AnyEntityClass } from "../entity/entity.js";
import { getDialect } from "../dbs/index.js";
import type { DialectImpl, QueryOperation } from "../dbs/types.js";
import {
  buildRelationJoins,
  buildRelationPathToAlias,
  buildOneToManyExists,
  getReusableJoinKeys,
  type RelationJoinInfo,
  type OneToManyExistsInfo,
} from "./helpers/relations/relation-joins.js";
import type { QueryState } from "./query-builder.js";
import type {
  Expr,
  ExprColumn,
  ExprAggregate,
  GroupByItem,
  JoinSpec,
  OrderItem,
  SelectItem,
} from "./expr.js";

export const DEFAULT_ROW_PARAM = "u";
const TABLE_ALIAS = "t0";

export function getDialectOrThrow(state: QueryState<unknown>): DialectImpl {
  return getDialect(state.qe.dialect);
}

export function isQueryBuilderValue(value: unknown): value is { state: QueryState<unknown> } {
  if (value == null || typeof value !== "object") return false;
  const state = (value as { state?: Partial<QueryState<unknown>> }).state;
  return (
    state != null &&
    typeof state === "object" &&
    typeof state.tableName === "string" &&
    Array.isArray(state.columnNames) &&
    "whereIr" in state &&
    "selectIr" in state
  );
}

/** Derive the row parameter name used in IR expressions (e.g. "u", "c")
 *  from whichever of selectIr, whereIr, or orderBy is available. */
export function getRootParam(state: QueryState<unknown>): string {
  if (state.selectIr?.param) return state.selectIr.param;
  if (state.whereIr) {
    const names = new Set<string>();
    collectParamNamesFromWhere(state.whereIr, names);
    const first = names.values().next().value;
    if (first) return first;
  }
  const firstOrder = state.orderBy[0]?.expr;
  if (firstOrder?.kind === "member") return firstOrder.param;
  return DEFAULT_ROW_PARAM;
}

// ─── plan types ───────────────────────────────────────────────────────────────

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

export interface JoinedProjection {
  relationKey: string;
  outputKey: string;
  /** Aliases in the result row that came from the JOIN, paired with their sub-path. */
  members: Array<{ alias: string; subPath: string }>;
}

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

interface OuterScope {
  subAlias: string;
  paramToAlias: Record<string, string>;
  localParamNames: string[];
}

// ─── public entry point ───────────────────────────────────────────────────────

export class QueryPlanBuilder {
  static build(state: QueryState<unknown>, operation: QueryOperation): QueryPlan {
    return new QueryPlanBuilder(state, operation).build();
  }

  /** Internal: build a plan for a child subquery state with outer scope info. */
  private static buildSub(
    state: QueryState<unknown>,
    operation: QueryOperation,
    outer: OuterScope,
  ): QueryPlan {
    return new QueryPlanBuilder(state, operation, outer).build();
  }

  private readonly state: QueryState<unknown>;
  private readonly operation: QueryOperation;
  private readonly outer?: OuterScope;
  private readonly tableAlias: string;
  private paramToAlias: Record<string, string> = {};
  private relationPathToAlias: Record<string, string> = {};
  private oneToManyExists: Record<string, OneToManyExistsInfo> = {};
  private joins: RelationJoinInfo[] = [];

  private constructor(
    state: QueryState<unknown>,
    operation: QueryOperation,
    outer?: OuterScope,
  ) {
    this.state = state;
    this.operation = operation;
    this.outer = outer;
    this.tableAlias = outer?.subAlias ?? TABLE_ALIAS;
  }

  private build(): QueryPlan {
    this.paramToAlias = this.buildParamToAlias();
    this.joins = this.outer ? [] : this.computeJoins();
    this.relationPathToAlias = buildRelationPathToAlias(
      this.joins,
      Object.keys(this.paramToAlias),
    );
    this.oneToManyExists = this.outer ? {} : this.computeOneToManyExists();

    const isSelect = this.operation.kind === "select";

    const classified = isSelect ? this.classifySelect() : EMPTY_CLASSIFIED;

    const selectAll = !this.state.selectIr || this.state.selectIr.paths.length === 0;
    const selectItems = isSelect ? this.buildSelectItems(classified) : [];

    const whereExpr = this.state.whereIr ? this.convertExpr(this.state.whereIr) : null;
    const havingExpr =
      isSelect && this.state.havingIr ? this.convertExpr(this.state.havingIr) : null;
    const orderBy = isSelect ? this.buildOrderBy() : [];
    const groupBy = isSelect ? this.buildGroupBy() : [];

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
      joins: this.joins.map(toJoinSpec),
      relationFetches: classified.relationFetches,
      joinedProjections: classified.joinedProjections,
      skipLoadFor: classified.skipLoadFor,
      whereParams: this.state.whereParams,
      havingParams: this.state.havingParams ?? {},
    };
  }

  // ─── alias / paramToAlias ───────────────────────────────────────────────────

  private buildParamToAlias(): Record<string, string> {
    const referenced = new Set<string>([DEFAULT_ROW_PARAM]);
    if (this.state.whereIr) collectParamNamesFromWhere(this.state.whereIr, referenced);
    for (const o of this.state.orderBy) {
      if (o.expr.kind === "member") referenced.add(o.expr.param);
    }
    if (this.state.selectIr) referenced.add(this.state.selectIr.param);
    this.collectOuterCorrelatedParams(referenced);

    const paramToAlias: Record<string, string> = { ...(this.outer?.paramToAlias ?? {}) };
    const localFilter = this.outer ? new Set(this.outer.localParamNames) : null;
    for (const p of referenced) {
      if (localFilter && !localFilter.has(p)) continue;
      paramToAlias[p] = this.tableAlias;
    }
    return paramToAlias;
  }

  private collectOuterCorrelatedParams(out: Set<string>): void {
    const refs = collectSubqueryRefs(this.state);
    const values = {
      ...this.state.whereParams,
      ...(this.state.havingParams ?? {}),
      ...this.state.subqueryParams,
    };
    for (const [key, value] of Object.entries(values)) {
      if (!isQueryBuilderValue(value)) continue;
      const innerRefs = new Set<string>();
      if (value.state.whereIr) collectParamNamesFromWhere(value.state.whereIr, innerRefs);
      for (const order of value.state.orderBy) collectParamNamesFromWhere(order.expr, innerRefs);
      const innerLocals = new Set(
        refs[key]?.localParamNames ?? getStateLocalParamNames(value.state),
      );
      for (const local of innerLocals) innerRefs.delete(local);
      for (const p of innerRefs) out.add(p);
    }
  }

  // ─── relation detection ─────────────────────────────────────────────────────

  private computeJoins(): RelationJoinInfo[] {
    const { relations, resolveRelationTarget } = this.state;
    if (!relations || Object.keys(relations).length === 0 || !resolveRelationTarget) {
      return [];
    }
    if (this.canSkipRelationAnalysis()) return [];
    return buildRelationJoins(
      {
        relations,
        tableName: this.state.tableName,
        columnNames: this.state.columnNames,
        pkColumns: this.state.pkColumns ?? ["id"],
        resolveTarget: resolveRelationTarget,
      },
      this.state.whereIr,
      getRootParam(this.state),
      this.state.orderBy,
      this.state.joinHints,
    );
  }

  private computeOneToManyExists(): Record<string, OneToManyExistsInfo> {
    if (!this.state.relations || !this.state.resolveRelationTarget) return {};
    if (this.canSkipRelationAnalysis()) return {};
    return buildOneToManyExists(
      this.state.whereIr,
      this.state.relations,
      getRootParam(this.state),
      this.state.pkColumns ?? ["id"],
      this.state.resolveRelationTarget,
    );
  }

  /** Mutations whose where/orderBy/joinHints reference no relations skip the analysis. */
  private canSkipRelationAnalysis(): boolean {
    if (this.operation.kind === "select") return false;
    if (this.state.joinHints?.length) return false;
    const relations = this.state.relations;
    if (!relations) return true;
    if (this.state.whereIr && nodeReferencesAnyRelation(this.state.whereIr, relations)) {
      return false;
    }
    for (const o of this.state.orderBy) {
      if (o.expr.kind === "member" && o.expr.path.length > 1 && o.expr.path[0] in relations) {
        return false;
      }
    }
    return true;
  }

  // ─── select classification ──────────────────────────────────────────────────

  private classifySelect(): ClassifiedSelect {
    const select = this.state.selectIr;
    const relations = this.state.relations;
    if (!select || !relations) return EMPTY_CLASSIFIED;

    const reusableJoinKeys = getReusableJoinKeys(
      this.state.whereIr,
      select,
      relations,
      getRootParam(this.state),
    );

    const hasRelations =
      select.relations?.length ||
      select.paths.some((p) => p.length >= 1 && relations[p[0]]);

    if (!hasRelations) {
      return {
        columnPaths: null,
        columnAliases: null,
        relationFetches: [],
        joinedProjections: [],
        skipLoadFor: new Set(),
        reusableJoinKeys,
      };
    }

    const pkColumns = this.state.pkColumns?.length ? this.state.pkColumns : ["id"];
    const joinedKeys = reusableJoinKeys.size > 0 ? reusableJoinKeys : undefined;

    const fromPaths = classifyPathEntries(select, relations, joinedKeys);
    const seenOutputKeys = new Set(fromPaths.relationFetches.map((m) => m.relation.outputKey));
    const fromRelations = classifyRelationEntries(select, relations, joinedKeys, seenOutputKeys);

    const columnPaths = [...fromPaths.columnPaths, ...fromRelations.columnPaths];
    const columnAliases = [...fromPaths.columnAliases, ...fromRelations.columnAliases];
    const relationFetches = [...fromPaths.relationFetches, ...fromRelations.relationFetches];

    const { paths: keyPaths, aliases: keyAliases } = missingJoinKeyColumns(
      relationFetches,
      columnPaths,
      pkColumns,
    );
    columnPaths.push(...keyPaths);
    columnAliases.push(...keyAliases);

    for (const f of relationFetches) {
      if (f.relationType === "one-to-many" || f.relationType === "many-to-many") {
        f.parentPkColumns = pkColumns;
      }
    }

    const hasReusableInSelect =
      reusableJoinKeys.size > 0 &&
      (select.paths.some((p) => p.length > 1 && reusableJoinKeys.has(p[0])) ||
        (select.relations ?? []).some(
          (r) => reusableJoinKeys.has(r.name) && (r.subPaths?.length ?? 0) > 0,
        ));

    const skipLoadFor = new Set<string>();
    if (hasReusableInSelect) {
      for (const p of select.paths) {
        if (p.length > 1 && reusableJoinKeys.has(p[0])) skipLoadFor.add(p[0]);
      }
      for (const r of select.relations ?? []) {
        if (reusableJoinKeys.has(r.name) && r.subPaths?.length) skipLoadFor.add(r.name);
      }
    }

    const joinedProjections = collectJoinedProjections(select, reusableJoinKeys);

    return {
      columnPaths,
      columnAliases,
      relationFetches,
      joinedProjections,
      skipLoadFor,
      reusableJoinKeys,
    };
  }

  // ─── select-list assembly ───────────────────────────────────────────────────

  private buildSelectItems(classified: ClassifiedSelect): SelectItem[] {
    const select = this.state.selectIr;
    if (!select) return [];

    const items: SelectItem[] = [];
    const paths = classified.columnPaths ?? select.paths;
    const aliases = classified.columnAliases ?? select.aliases ?? [];
    const rootParam = select.param;

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const explicit = aliases[i];
      if (path.length === 0) {
        items.push({ expr: this.resolveColumn(rootParam, path) });
      } else {
        items.push({
          expr: this.resolveColumn(rootParam, path),
          alias: explicit,
        });
      }
    }

    if (select.rest) {
      const explicitCols = new Set(paths.map((p) => p[0]));
      for (const c of this.state.columnNames) {
        if (!explicitCols.has(c)) {
          items.push({ expr: { kind: "column", alias: this.tableAlias, column: c } });
        }
      }
    }

    if (select.aggregates?.length) {
      for (const agg of select.aggregates) {
        items.push({ expr: this.convertAggregate(agg), alias: agg.alias });
      }
    }

    if (select.subqueries?.length) {
      for (const entry of select.subqueries) {
        items.push({
          expr: this.convertSubqueryRef(entry.subquery),
          alias: entry.alias,
        });
      }
    }

    return items;
  }

  // ─── orderBy / groupBy ──────────────────────────────────────────────────────

  private buildOrderBy(): OrderItem[] {
    return this.state.orderBy.map((o) => ({
      expr:
        o.expr.kind === "member"
          ? this.resolveOrderByMember(o.expr)
          : this.convertExpr(o.expr),
      direction: o.direction,
    }));
  }

  /** ORDER BY uses min-path-length-2 for relation rewrite — `u.company` stays
   *  on the main table even when "company" is a relation key. */
  private resolveOrderByMember(node: IrMember): ExprColumn {
    return this.resolveColumnWithMinLen(node.param, node.path, 2);
  }

  private buildGroupBy(): GroupByItem[] {
    const entries = this.state.selectIr?.groupBy ?? [];
    return entries.map((entry) => {
      if (typeof entry === "number") return { kind: "index", index: entry };
      if (entry.length === 0) throw new Error("[typhex] GROUP BY path cannot be empty");
      return this.resolveColumn(this.state.selectIr?.param ?? DEFAULT_ROW_PARAM, entry);
    });
  }

  // ─── IR → Expr ──────────────────────────────────────────────────────────────

  private convertExpr(node: IrNode): Expr {
    switch (node.kind) {
      case "binary":
        return {
          kind: "binary",
          op: node.op,
          left: this.convertExpr(node.left),
          right: this.convertExpr(node.right),
        };
      case "unary":
        return { kind: "unary", op: node.op, operand: this.convertExpr(node.operand) };
      case "member":
        return this.resolveColumn(node.param, node.path);
      case "const":
        return { kind: "const", value: node.value };
      case "param":
        return this.resolveParamRef(node.key);
      case "in":
        return this.convertInNode(node);
      case "call":
        return {
          kind: "call",
          method: node.method,
          receiver: this.convertExpr(node.receiver),
          args: node.args.map((a) => this.convertExpr(a)),
        };
      case "exists":
        return this.convertExistsNode(node);
      case "subqueryRef":
        return this.convertSubqueryRef(node);
      case "aggregate":
        return this.convertAggregate(node);
      default:
        throw new Error(`[typhex] Unknown IR node kind: ${(node as { kind: string }).kind}`);
    }
  }

  private resolveParamRef(key: string): Expr {
    const value = this.lookupParamValue(key);
    if (isQueryBuilderValue(value)) {
      return this.buildSubqueryFromQbValue(key, value);
    }
    return { kind: "param", name: key };
  }

  private convertInNode(node: IrNode & { kind: "in" }): Expr {
    const left = this.convertExpr(node.left);
    const right = node.right;
    if (right.kind === "const" && Array.isArray(right.value)) {
      return {
        kind: "in",
        left,
        right: { kind: "values", values: right.value },
        negated: node.negated,
      };
    }
    if (right.kind === "param") {
      const value = this.lookupParamValue(right.key);
      if (isQueryBuilderValue(value)) {
        return {
          kind: "in",
          left,
          right: { kind: "subquery", plan: this.buildChildPlan(right.key, value) },
          negated: node.negated,
        };
      }
      return {
        kind: "in",
        left,
        right: { kind: "param", name: right.key },
        negated: node.negated,
      };
    }
    if (right.kind === "subqueryRef") {
      const value = this.lookupParamValue(right.key);
      if (!isQueryBuilderValue(value)) {
        throw new Error(`[typhex] subqueryRef "${right.key}" did not resolve to a QueryBuilder`);
      }
      return {
        kind: "in",
        left,
        right: { kind: "subquery", plan: this.buildChildPlan(right.key, value, right) },
        negated: node.negated,
      };
    }
    throw new Error("[typhex] IN right side must be const array, param, or subqueryRef");
  }

  private convertExistsNode(node: IrNode & { kind: "exists" }): Expr {
    const info = this.oneToManyExists[`${node.rootParam}.${node.relationKey}`];
    if (!info) {
      throw new Error(
        `[typhex] No oneToManyExists info for ${node.rootParam}.${node.relationKey}`,
      );
    }
    const innerScope: Record<string, string> = {
      ...this.paramToAlias,
      [node.innerParam]: info.alias,
    };
    const inner = new ExprConverter(
      innerScope,
      this.relationPathToAlias,
      this.oneToManyExists,
      (ref) => this.convertSubqueryRef(ref),
      (key) => this.resolveParamRef(key),
    );
    const predicate = inner.convert(node.innerWhere);
    return {
      kind: "exists",
      negated: node.negated,
      outerAlias: this.tableAlias,
      innerAlias: info.alias,
      targetTable: info.targetTable,
      fkColumns: info.fkColumns,
      mainPk: info.mainPk,
      predicate,
    };
  }

  private convertSubqueryRef(ref: IrSubqueryRef): Expr {
    const value = this.lookupParamValue(ref.key);
    if (!isQueryBuilderValue(value)) {
      throw new Error(`[typhex] subqueryRef "${ref.key}" did not resolve to a QueryBuilder`);
    }
    return { kind: "subquery", plan: this.buildChildPlan(ref.key, value, ref) };
  }

  private convertAggregate(agg: IrAggregate): ExprAggregate {
    return {
      kind: "aggregate",
      func: agg.func,
      arg: agg.arg ? this.convertExpr(agg.arg) : null,
      alias: agg.alias,
      distinct: agg.distinct,
      separator: agg.separator,
    };
  }

  private buildSubqueryFromQbValue(
    key: string,
    value: { state: QueryState<unknown> },
  ): Expr {
    return { kind: "subquery", plan: this.buildChildPlan(key, value) };
  }

  private buildChildPlan(
    key: string,
    value: { state: QueryState<unknown> },
    ref?: IrSubqueryRef,
  ): QueryPlan {
    const used = this.collectUsedAliases();
    const subAlias = nextFreeAlias(used);
    const localParamNames =
      ref?.localParamNames ?? getStateLocalParamNames(value.state);
    return QueryPlanBuilder.buildSub(
      value.state,
      { kind: "select" },
      {
        subAlias,
        paramToAlias: this.paramToAlias,
        localParamNames,
      },
    );
  }

  private collectUsedAliases(): Set<string> {
    const used = new Set<string>([this.tableAlias]);
    for (const a of Object.values(this.paramToAlias)) used.add(a);
    for (const a of Object.values(this.relationPathToAlias)) used.add(a);
    return used;
  }

  private lookupParamValue(key: string): unknown {
    if (key in this.state.whereParams) return this.state.whereParams[key];
    if (this.state.havingParams && key in this.state.havingParams) {
      return this.state.havingParams[key];
    }
    if (key in this.state.subqueryParams) return this.state.subqueryParams[key];
    return undefined;
  }

  // ─── alias resolution ───────────────────────────────────────────────────────

  private resolveColumn(param: string, path: string[]): ExprColumn {
    return this.resolveColumnWithMinLen(param, path, 1);
  }

  private resolveColumnWithMinLen(
    param: string,
    path: string[],
    minPathLenForRewrite: number,
  ): ExprColumn {
    let alias = this.paramToAlias[param] ?? this.tableAlias;
    let p = path;
    if (path.length >= minPathLenForRewrite) {
      const relAlias = this.relationPathToAlias[`${param}.${path[0]}`];
      if (relAlias) {
        alias = relAlias;
        p = path.slice(1);
      }
    }
    if (p.length === 0) return { kind: "column", alias, column: "" };
    if (p.length === 1) return { kind: "column", alias, column: p[0] };
    // Multi-segment paths after rewrite are rare; preserve old behavior of
    // joining segments with "."
    return { kind: "column", alias, column: p.join('"."') };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

interface ClassifiedSelect {
  columnPaths: string[][] | null;
  columnAliases: string[] | null;
  relationFetches: RelationFetchMetadata[];
  joinedProjections: JoinedProjection[];
  skipLoadFor: Set<string>;
  reusableJoinKeys: Set<string>;
}

const EMPTY_CLASSIFIED: ClassifiedSelect = {
  columnPaths: null,
  columnAliases: null,
  relationFetches: [],
  joinedProjections: [],
  skipLoadFor: new Set(),
  reusableJoinKeys: new Set(),
};

function nodeReferencesAnyRelation(node: IrNode, relations: RelationsMap): boolean {
  switch (node.kind) {
    case "member":
      return node.path.length >= 1 && node.path[0] in relations;
    case "binary":
      return (
        nodeReferencesAnyRelation(node.left, relations) ||
        nodeReferencesAnyRelation(node.right, relations)
      );
    case "unary":
      return nodeReferencesAnyRelation(node.operand, relations);
    case "in":
      return (
        nodeReferencesAnyRelation(node.left, relations) ||
        nodeReferencesAnyRelation(node.right, relations)
      );
    case "call":
      return (
        nodeReferencesAnyRelation(node.receiver, relations) ||
        node.args.some((a) => nodeReferencesAnyRelation(a, relations))
      );
    case "exists":
      return true;
    default:
      return false;
  }
}

function nextFreeAlias(used: Set<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `t${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

function toJoinSpec(j: RelationJoinInfo): JoinSpec {
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

function collectSubqueryRefs(state: QueryState<unknown>): Record<string, IrSubqueryRef> {
  const refs: Record<string, IrSubqueryRef> = {};
  const visit = (node: IrNode | null | undefined): void => {
    if (!node) return;
    switch (node.kind) {
      case "subqueryRef":
        refs[node.key] = node;
        break;
      case "binary":
        visit(node.left);
        visit(node.right);
        break;
      case "unary":
        visit(node.operand);
        break;
      case "in":
        visit(node.left);
        visit(node.right);
        break;
      case "call":
        visit(node.receiver);
        for (const arg of node.args) visit(arg);
        break;
      case "aggregate":
        visit(node.arg);
        break;
      default:
        break;
    }
  };
  visit(state.whereIr);
  visit(state.havingIr);
  for (const order of state.orderBy) visit(order.expr);
  for (const entry of state.selectIr?.subqueries ?? []) refs[entry.subquery.key] = entry.subquery;
  return refs;
}

function getStateLocalParamNames(state: QueryState<unknown>): string[] {
  const names = new Set<string>();
  if (state.selectIr?.param) names.add(state.selectIr.param);
  for (const order of state.orderBy) {
    if (order.expr.kind === "member") names.add(order.expr.param);
  }
  if (state.whereIr) collectParamNamesFromWhere(state.whereIr, names);
  return [...names];
}

// ─── select classification (was relation-context-builder.ts) ──────────────────

function classifyPathEntries(
  select: IrSelect,
  relations: RelationsMap,
  joinedRelationKeys: Set<string> | undefined,
) {
  const relNames = new Set(Object.keys(relations));
  const columnPaths: string[][] = [];
  const columnAliases: string[] = [];
  const relationFetches: RelationFetchMetadata[] = [];

  for (let i = 0; i < select.paths.length; i++) {
    const path = select.paths[i];
    const alias = select.aliases?.[i] ?? path[path.length - 1];

    if (path.length === 1 && relNames.has(path[0])) {
      const meta = buildRelationFetchMeta({ name: path[0], outputKey: alias }, relations[path[0]]);
      if (meta) relationFetches.push(meta);
    } else if (path.length > 1 && relNames.has(path[0])) {
      if (joinedRelationKeys?.has(path[0])) {
        columnPaths.push(path);
        columnAliases.push(select.aliases?.[i] ?? `${path[0]}_${path[path.length - 1]}`);
      } else {
        const meta = buildRelationFetchMeta(
          { name: path[0], outputKey: alias, subPaths: [path.slice(1)] },
          relations[path[0]],
        );
        if (meta) relationFetches.push(meta);
      }
    } else {
      columnPaths.push(path);
      columnAliases.push(alias);
    }
  }

  return { columnPaths, columnAliases, relationFetches };
}

function classifyRelationEntries(
  select: IrSelect,
  relations: RelationsMap,
  joinedRelationKeys: Set<string> | undefined,
  seenOutputKeys: Set<string>,
) {
  const columnPaths: string[][] = [];
  const columnAliases: string[] = [];
  const relationFetches: RelationFetchMetadata[] = [];

  for (const r of select.relations ?? []) {
    const relDef = relations[r.name];
    if (!relDef || seenOutputKeys.has(r.outputKey)) continue;
    seenOutputKeys.add(r.outputKey);

    if (joinedRelationKeys?.has(r.name) && r.subPaths?.length) {
      for (const sub of r.subPaths) {
        if (sub.length > 0) {
          columnPaths.push([r.name, ...sub]);
          columnAliases.push(`${r.outputKey}_${sub.join("_")}`);
        }
      }
    } else {
      const meta = buildRelationFetchMeta(r, relDef);
      if (meta) relationFetches.push(meta);
    }
  }

  return { columnPaths, columnAliases, relationFetches };
}

function missingJoinKeyColumns(
  fetches: RelationFetchMetadata[],
  existingPaths: string[][],
  pkColumns: string[],
): { paths: string[][]; aliases: string[] } {
  const paths: string[][] = [];
  const aliases: string[] = [];
  const added = new Set(existingPaths.map((p) => p[0]));

  for (const meta of fetches) {
    const isMany = meta.relationType === "one-to-many" || meta.relationType === "many-to-many";
    const cols = isMany ? pkColumns : meta.fkColumns;
    for (const col of cols) {
      if (!added.has(col)) {
        paths.push([col]);
        aliases.push(col);
        added.add(col);
      }
    }
  }
  return { paths, aliases };
}

function collectJoinedProjections(
  select: IrSelect,
  reusableJoinKeys: Set<string>,
): JoinedProjection[] {
  const byKey = new Map<string, JoinedProjection>();
  for (const relKey of reusableJoinKeys) {
    byKey.set(relKey, { relationKey: relKey, outputKey: relKey, members: [] });
  }
  for (let i = 0; i < select.paths.length; i++) {
    const path = select.paths[i];
    if (path.length > 1 && reusableJoinKeys.has(path[0])) {
      const proj = byKey.get(path[0])!;
      const subField = path[path.length - 1];
      const alias = select.aliases?.[i] ?? `${path[0]}_${subField}`;
      proj.members.push({ alias, subPath: subField });
    }
  }
  for (const r of select.relations ?? []) {
    if (reusableJoinKeys.has(r.name) && r.subPaths?.length) {
      const proj = byKey.get(r.name)!;
      proj.outputKey = r.outputKey;
      for (const sub of r.subPaths) {
        if (sub.length > 0) {
          proj.members.push({
            alias: `${r.outputKey}_${sub.join("_")}`,
            subPath: sub[sub.length - 1],
          });
        }
      }
    }
  }
  return [...byKey.values()].filter((p) => p.members.length > 0);
}

function buildRelationFetchMeta(
  ir: IrSelectRelation,
  relDef: RelationDef,
): RelationFetchMetadata | null {
  const target = relDef._target();
  const targetEntity =
    target && typeof (target as Partial<AnyEntityClass>).query === "function"
      ? (target as AnyEntityClass)
      : null;
  if (!targetEntity) return null;

  const targetSchema = (targetEntity as { table?: { _schema: Record<string, string> } }).table
    ?._schema;
  const targetPkColumnsFromSchema = targetSchema ? getPkColumnsFromSchema(targetSchema) : ["id"];

  switch (relDef._relType) {
    case "many-to-one":
    case "one-to-one": {
      const opts = relDef._options as RelationOptions;
      return {
        relationType: relDef._relType,
        relation: ir,
        fkColumns: toArray(opts.foreignKey),
        targetPkColumns:
          opts.references != null ? toArray(opts.references) : targetPkColumnsFromSchema,
        targetEntity,
      };
    }
    case "one-to-many": {
      const opts = relDef._options as { foreignKey: string | string[] };
      return {
        relationType: "one-to-many",
        relation: ir,
        fkColumns: toArray(opts.foreignKey),
        targetPkColumns: targetPkColumnsFromSchema,
        targetEntity,
      };
    }
    case "many-to-many": {
      const j = relDef._options as JunctionOptions;
      return {
        relationType: "many-to-many",
        relation: ir,
        fkColumns: toArray(j.referenceKey),
        targetPkColumns: targetPkColumnsFromSchema,
        targetEntity,
        junction: {
          table: j.junction,
          foreignKey: toArray(j.foreignKey),
          referenceKey: toArray(j.referenceKey),
        },
      };
    }
    default:
      return null;
  }
}

// ─── ExprConverter (used for nested EXISTS predicates) ────────────────────────

class ExprConverter {
  constructor(
    private readonly paramToAlias: Record<string, string>,
    private readonly relationPathToAlias: Record<string, string>,
    private readonly oneToManyExists: Record<string, OneToManyExistsInfo>,
    private readonly convertSubqueryRefFn: (ref: IrSubqueryRef) => Expr,
    private readonly resolveParamFn: (key: string) => Expr,
  ) {}

  convert(node: IrNode): Expr {
    switch (node.kind) {
      case "binary":
        return {
          kind: "binary",
          op: node.op,
          left: this.convert(node.left),
          right: this.convert(node.right),
        };
      case "unary":
        return { kind: "unary", op: node.op, operand: this.convert(node.operand) };
      case "member":
        return this.resolveColumn(node.param, node.path);
      case "const":
        return { kind: "const", value: node.value };
      case "param":
        return this.resolveParamFn(node.key);
      case "in":
        return this.convertIn(node);
      case "call":
        return {
          kind: "call",
          method: node.method,
          receiver: this.convert(node.receiver),
          args: node.args.map((a) => this.convert(a)),
        };
      case "exists":
        return this.convertExists(node);
      case "subqueryRef":
        return this.convertSubqueryRefFn(node);
      case "aggregate":
        return {
          kind: "aggregate",
          func: node.func,
          arg: node.arg ? this.convert(node.arg) : null,
          alias: node.alias,
          distinct: node.distinct,
          separator: node.separator,
        };
      default:
        throw new Error(`[typhex] Unknown IR node kind: ${(node as { kind: string }).kind}`);
    }
  }

  private convertIn(node: IrNode & { kind: "in" }): Expr {
    const left = this.convert(node.left);
    const right = node.right;
    if (right.kind === "const" && Array.isArray(right.value)) {
      return {
        kind: "in",
        left,
        right: { kind: "values", values: right.value },
        negated: node.negated,
      };
    }
    if (right.kind === "param") {
      return {
        kind: "in",
        left,
        right: { kind: "param", name: right.key },
        negated: node.negated,
      };
    }
    if (right.kind === "subqueryRef") {
      const sq = this.convertSubqueryRefFn(right);
      if (sq.kind !== "subquery") {
        throw new Error("[typhex] subqueryRef did not yield Expr.subquery");
      }
      return {
        kind: "in",
        left,
        right: { kind: "subquery", plan: sq.plan },
        negated: node.negated,
      };
    }
    throw new Error("[typhex] IN right side must be const array, param, or subqueryRef");
  }

  private convertExists(node: IrNode & { kind: "exists" }): Expr {
    const info = this.oneToManyExists[`${node.rootParam}.${node.relationKey}`];
    if (!info) {
      throw new Error(
        `[typhex] No oneToManyExists info for ${node.rootParam}.${node.relationKey}`,
      );
    }
    const innerScope: Record<string, string> = {
      ...this.paramToAlias,
      [node.innerParam]: info.alias,
    };
    const inner = new ExprConverter(
      innerScope,
      this.relationPathToAlias,
      this.oneToManyExists,
      this.convertSubqueryRefFn,
      this.resolveParamFn,
    );
    const predicate = inner.convert(node.innerWhere);
    return {
      kind: "exists",
      negated: node.negated,
      outerAlias: this.paramToAlias[node.rootParam] ?? TABLE_ALIAS,
      innerAlias: info.alias,
      targetTable: info.targetTable,
      fkColumns: info.fkColumns,
      mainPk: info.mainPk,
      predicate,
    };
  }

  private resolveColumn(param: string, path: string[]): ExprColumn {
    let alias = this.paramToAlias[param] ?? TABLE_ALIAS;
    let p = path;
    if (path.length >= 1) {
      const relAlias = this.relationPathToAlias[`${param}.${path[0]}`];
      if (relAlias) {
        alias = relAlias;
        p = path.slice(1);
      }
    }
    if (p.length === 0) return { kind: "column", alias, column: "" };
    if (p.length === 1) return { kind: "column", alias, column: p[0] };
    return { kind: "column", alias, column: p.join('"."') };
  }
}

/** Use `JoinHint`-typed import to silence unused warnings if the parameter
 *  isn't surfaced — the field IS read inside computeJoins. */
export type { JoinHint };
