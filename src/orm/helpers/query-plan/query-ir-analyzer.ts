import type { IrExists, IrNode, IrOrderBy, IrSelect, IrSubqueryRef } from "../../../ir/types.js";
import type { RelationsMap } from "../../../entity/relations.js";
import type { QueryState } from "../../query-builder.js";

export interface ExprIrAnalysis {
  paramNames: Set<string>;
  relationKeys: Set<string>;
  subqueryRefs: Record<string, IrSubqueryRef>;
  existsNodes: IrExists[];
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
  whereAndOrderBy: ExprIrAnalysis;
  all: ExprIrAnalysis;
  joinRelationKeys: Set<string>;
  reusableJoinKeys: Set<string>;
}

export class QueryIrAnalyzer {
  static analyze(state: QueryState<unknown>, fallbackParam: string): QueryIrAnalysis {
    return new QueryIrAnalyzer(state, fallbackParam).analyze();
  }

  private readonly relations: RelationsMap | undefined;

  private constructor(
    private readonly state: QueryState<unknown>,
    private readonly fallbackParam: string,
  ) {
    this.relations = state.relations;
  }

  private analyze(): QueryIrAnalysis {
    const rootParam = this.inferRootParam();
    const where = this.analyzeExprIr(this.state.whereIr?.node, rootParam);
    const having = this.analyzeExprIr(this.state.havingIr?.node, rootParam);
    const orderBy = this.analyzeOrderBy(this.state.orderBy, rootParam);
    const select = this.analyzeSelectIr(this.state.selectIr);
    const whereAndOrderBy = this.merge(where, orderBy);
    const joinRelationKeys = this.relationKeysWithHints(whereAndOrderBy.relationKeys);
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
      whereAndOrderBy,
      all: this.merge(where, having, orderBy, select),
      joinRelationKeys,
      reusableJoinKeys: this.reusableJoinKeys(where.relationKeys, select.relationKeys),
    };
  }

  private inferRootParam(): string {
    if (this.state.selectIr?.param) return this.state.selectIr.param;
    if (this.state.whereIr?.rootParam) return this.state.whereIr.rootParam;
    const firstOrder = this.state.orderBy[0]?.expr;
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
    for (const order of this.state.orderBy) {
      if (order.expr.kind === "member") names.add(order.expr.param);
    }
    return [...names];
  }

  private analyzeSubqueries(): Record<string, QueryIrAnalysis> {
    const analyses: Record<string, QueryIrAnalysis> = {};
    for (const [key, captured] of Object.entries(this.state.subqueryParams)) {
      analyses[key] = QueryIrAnalyzer.analyze(captured.state, this.fallbackParam);
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

  private analyzeExprIr(
    node: IrNode | null | undefined,
    rootParam: string,
    relationMinPathLength = 1,
    requireRootParamForRelations = true,
  ): ExprIrAnalysis {
    const out = this.empty();

    const visit = (n: IrNode | null | undefined): void => {
      if (!n) return;
      switch (n.kind) {
        case "member":
          out.paramNames.add(n.param);
          if (
            (!requireRootParamForRelations || n.param === rootParam) &&
            n.path.length >= relationMinPathLength &&
            this.relations?.[n.path[0]]
          ) {
            out.relationKeys.add(n.path[0]);
          }
          break;
        case "subqueryRef":
          out.subqueryRefs[n.key] = n;
          break;
        case "exists":
          out.paramNames.add(n.rootParam);
          if (n.rootParam === rootParam) out.relationKeys.add(n.relationKey);
          out.existsNodes.push(n);
          break;
        case "binary":
          visit(n.left);
          visit(n.right);
          break;
        case "unary":
          visit(n.operand);
          break;
        case "in":
          visit(n.left);
          visit(n.right);
          break;
        case "call":
          visit(n.receiver);
          for (const arg of n.args) visit(arg);
          break;
        case "aggregate":
          visit(n.arg);
          break;
        default:
          break;
      }
    };

    visit(node);
    return out;
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
    };
  }

  private mergeInto(target: ExprIrAnalysis, source: ExprIrAnalysis): void {
    for (const param of source.paramNames) target.paramNames.add(param);
    for (const key of source.relationKeys) target.relationKeys.add(key);
    Object.assign(target.subqueryRefs, source.subqueryRefs);
    target.existsNodes.push(...source.existsNodes);
  }
}
