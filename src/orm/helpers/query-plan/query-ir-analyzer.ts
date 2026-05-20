import type { IrExists, IrNode, IrOrderBy, IrSelect, IrSubqueryRef } from "../../../ir/types.js";
import type { RelationsMap } from "../../../entity/relations.js";
import type { QueryState } from "../../query-builder.js";

export interface ExprIrAnalysis {
  paramNames: Set<string>;
  relationKeys: Set<string>;
  subqueryRefs: Record<string, IrSubqueryRef>;
  existsNodes: IrExists[];
  referencedRegisteredCtes: Set<string>;
}

export interface QueryIrAnalysis {
  rootParam: string;
  localParamNames: string[];
  correlatedParamNames: Set<string>;
  subqueries: Record<string, QueryIrAnalysis>;
  where: ExprIrAnalysis;
  having: ExprIrAnalysis;
  orderBy: ExprIrAnalysis;
  select: ExprIrAnalysis;
  all: ExprIrAnalysis;
  joinRelationKeys: Set<string>;
  reusableJoinKeys: Set<string>;
}

interface ExprVisitCtx {
  rootParam: string;
  relationMinPathLength: number;
  requireRootParamForRelations: boolean;
}

export class QueryIrAnalyzer {
  private readonly relations: RelationsMap | undefined;
  private readonly registeredCteNames: Set<string>;

  constructor(
    private readonly state: QueryState<unknown>,
    private readonly fallbackParam: string,
  ) {
    this.relations = state.relations;
    this.registeredCteNames = new Set([
      ...(state.inScopeRegisteredCteNames ?? []),
      ...(state.ctes ?? []).map((c) => c.name),
    ]);
  }

  analyze(): QueryIrAnalysis {
    const rootParam = this.inferRootParam();
    const where = this.analyzeExprIr(this.state.whereIr?.node, rootParam);
    const having = this.analyzeExprIr(this.state.havingIr?.node, rootParam);
    const orderBy = this.analyzeOrderBy(this.state.orderBy ?? [], rootParam);
    const select = this.analyzeSelectIr(this.state.selectIr);
    const updateSet = this.analyzeUpsertIr(this.state.updateSetIr, rootParam);
    const insertValues = this.analyzeUpsertIr(this.state.insertIr, rootParam);
    const joinSources = this.merge(where, orderBy);
    const joinRelationKeys = this.relationKeysWithHints(joinSources.relationKeys);
    const subqueries = this.analyzeSubqueries();
    const correlatedParamNames = this.getCorrelatedParamNames(subqueries);

    return {
      rootParam,
      localParamNames: this.getLocalParamNames(),
      correlatedParamNames,
      subqueries,
      where,
      having,
      orderBy,
      select,
      all: this.merge(where, having, orderBy, select, updateSet, insertValues),
      joinRelationKeys,
      reusableJoinKeys: this.reusableJoinKeys(where.relationKeys, select.relationKeys),
    };
  }

  private inferRootParam(): string {
    if (this.state.selectIr?.param) return this.state.selectIr.param;
    if (this.state.whereIr?.rootParam) return this.state.whereIr.rootParam;
    if (this.state.havingIr?.rootParam) return this.state.havingIr.rootParam;
    const firstOrder = this.state.orderBy?.[0]?.expr;
    if (firstOrder?.kind === "member") return firstOrder.param;
    return this.fallbackParam;
  }

  private getLocalParamNames(): string[] {
    const names = new Set<string>();
    if (this.state.selectIr?.param) names.add(this.state.selectIr.param);
    if (this.state.whereIr) {
      for (const param of this.state.whereIr.localParamNames ?? [this.state.whereIr.rootParam]) {
        names.add(param);
      }
    }
    if (this.state.havingIr) {
      for (const param of this.state.havingIr.localParamNames ?? [this.state.havingIr.rootParam]) {
        names.add(param);
      }
    }
    for (const order of this.state.orderBy ?? []) {
      if (order.expr.kind === "member") names.add(order.expr.param);
    }
    return [...names];
  }

  private analyzeSubqueries(): Record<string, QueryIrAnalysis> {
    const analyses: Record<string, QueryIrAnalysis> = {};
    for (const [key, captured] of Object.entries(this.state.subqueryParams ?? {})) {
      analyses[key] = new QueryIrAnalyzer(captured.state, this.fallbackParam).analyze();
    }
    return analyses;
  }

  private getCorrelatedParamNames(subqueries: Record<string, QueryIrAnalysis>): Set<string> {
    const names = new Set<string>();
    for (const analysis of Object.values(subqueries)) {
      const required = new Set([...analysis.all.paramNames, ...analysis.correlatedParamNames]);
      for (const param of analysis.localParamNames) required.delete(param);
      for (const param of required) names.add(param);
    }
    return names;
  }

  private analyzeOrderBy(orderBy: IrOrderBy[], rootParam: string): ExprIrAnalysis {
    const out = this.empty();
    for (const order of orderBy) {
      this.mergeInto(out, this.analyzeExprIr(order.expr, rootParam, 2, false));
    }
    return out;
  }

  private analyzeSelectIr(select: IrSelect | null): ExprIrAnalysis {
    const out = this.empty();
    if (!select) return out;

    out.paramNames.add(select.param);
    for (const path of select.paths) {
      if (path.length > 0 && this.relations?.[path[0]]) out.relationKeys.add(path[0]);
    }
    for (const relation of select.relations ?? []) {
      if (this.relations?.[relation.name]) out.relationKeys.add(relation.name);
      if (relation.whereIr) {
        this.mergeInto(out, this.analyzeExprIr(relation.whereIr.node, relation.whereIr.rootParam));
      }
      for (const order of relation.orderBy ?? []) {
        this.mergeInto(out, this.analyzeExprIr(order.expr, select.param, 2));
      }
    }
    for (const aggregate of select.aggregates ?? []) {
      this.mergeInto(out, this.analyzeExprIr(aggregate.arg, select.param));
    }
    for (const entry of select.subqueries ?? []) {
      out.subqueryRefs[entry.subquery.key] = entry.subquery;
    }
    return out;
  }

  private analyzeUpsertIr(
    values: Record<string, IrNode> | undefined,
    rootParam: string,
  ): ExprIrAnalysis {
    const out = this.empty();
    for (const node of Object.values(values ?? {})) {
      this.mergeInto(out, this.analyzeExprIr(node, rootParam));
    }
    return out;
  }

  private analyzeExprIr(
    node: IrNode | null | undefined,
    rootParam: string,
    relationMinPathLength = 1,
    requireRootParamForRelations = true,
  ): ExprIrAnalysis {
    const out = this.empty();
    this.visitExprIr(node, { rootParam, relationMinPathLength, requireRootParamForRelations }, out);
    return out;
  }

  /** Pre-order: accumulate analysis, then recurse. Child edges match ExprBuilder; skips exists.innerWhere. */
  private visitExprIr(
    node: IrNode | null | undefined,
    ctx: ExprVisitCtx,
    out: ExprIrAnalysis,
  ): void {
    if (!node) return;

    switch (node.kind) {
      case "member":
        out.paramNames.add(node.param);
        if (node.path.length > 0 && this.registeredCteNames.has(node.path[0])) {
          out.referencedRegisteredCtes.add(node.path[0]);
        }
        if (
          (!ctx.requireRootParamForRelations || node.param === ctx.rootParam) &&
          node.path.length >= ctx.relationMinPathLength &&
          this.relations?.[node.path[0]]
        ) {
          out.relationKeys.add(node.path[0]);
        }
        return;
      case "subqueryRef":
        out.subqueryRefs[node.key] = node;
        return;
      case "exists":
        out.paramNames.add(node.rootParam);
        if (node.rootParam === ctx.rootParam) out.relationKeys.add(node.relationKey);
        out.existsNodes.push(node);
        return;
      case "binary":
        this.visitExprIr(node.left, ctx, out);
        this.visitExprIr(node.right, ctx, out);
        return;
      case "unary":
        this.visitExprIr(node.operand, ctx, out);
        return;
      case "in":
        this.visitExprIr(node.left, ctx, out);
        this.visitExprIr(node.right, ctx, out);
        return;
      case "call":
        this.visitExprIr(node.receiver, ctx, out);
        for (const arg of node.args) this.visitExprIr(arg, ctx, out);
        return;
      case "aggregate":
        this.visitExprIr(node.arg, ctx, out);
        return;
      case "case":
        for (const b of node.branches) {
          this.visitExprIr(b.when, ctx, out);
          this.visitExprIr(b.then, ctx, out);
        }
        if (node.else) this.visitExprIr(node.else, ctx, out);
        return;
      case "const":
      case "param":
        return;
      default: {
        const _exhaustive: never = node;
        return _exhaustive;
      }
    }
  }

  private relationKeysWithHints(relationKeys: Set<string>): Set<string> {
    const out = new Set(relationKeys);
    if (!this.relations || !this.state.joinHints) return out;
    for (const hint of this.state.joinHints) {
      if (hint.relationKey in this.relations) out.add(hint.relationKey);
    }
    return out;
  }

  private reusableJoinKeys(whereKeys: Set<string>, selectKeys: Set<string>): Set<string> {
    const out = new Set<string>();
    if (!this.relations) return out;
    for (const key of whereKeys) {
      if (!selectKeys.has(key)) continue;
      if (this.relations[key]?._relType === "one-to-many") continue;
      out.add(key);
    }
    return out;
  }

  private merge(...items: ExprIrAnalysis[]): ExprIrAnalysis {
    const out = this.empty();
    for (const item of items) this.mergeInto(out, item);
    return out;
  }

  private empty(): ExprIrAnalysis {
    return {
      paramNames: new Set(),
      relationKeys: new Set(),
      subqueryRefs: {},
      existsNodes: [],
      referencedRegisteredCtes: new Set(),
    };
  }

  private mergeInto(target: ExprIrAnalysis, source: ExprIrAnalysis): void {
    for (const param of source.paramNames) target.paramNames.add(param);
    for (const key of source.relationKeys) target.relationKeys.add(key);
    Object.assign(target.subqueryRefs, source.subqueryRefs);
    target.existsNodes.push(...source.existsNodes);
    for (const name of source.referencedRegisteredCtes) {
      target.referencedRegisteredCtes.add(name);
    }
  }

  /** Ordered registered CTE names referenced in IR (where/having/select + updateSetIr / insertIr from analyze()). */
  planReferencedRegisteredCtes(analysis: QueryIrAnalysis): string[] {
    return orderReferencedRegisteredCtes(
      analysis.all.referencedRegisteredCtes,
      this.state.inScopeRegisteredCteNames,
      this.state.ctes?.map((c) => c.name),
    );
  }
}

function orderReferencedRegisteredCtes(
  referenced: Set<string>,
  inScopeRegisteredCteNames: string[] | undefined,
  cteNames: string[] | undefined,
): string[] {
  const order = [...(inScopeRegisteredCteNames ?? []), ...(cteNames ?? [])];
  const seen = new Set<string>();
  return order.filter((n) => {
    if (!referenced.has(n) || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}
