/**
 * Detect inline `Entity.query()[.where(fn)].<aggMethod>(...)` chains in TS
 * source and convert them to IrSubquery nodes with `aggregate` set.
 *
 * Lives in its own module so both select-transformer (for SELECT-list
 * subquery columns) and where-transformer (for binary aggregate-comparison
 * filters) can import it without a circular dependency.
 */

import * as ts from "typescript";
import type { IrNode, IrOrderBy, IrSubquery, IrSubqueryAggregate } from "../ir/types.js";
import { computeOuterCorrelatedParams, validateIrSubquery } from "../ir/types.js";
import {
  parseWhereArrowToIr,
  extractTableName,
  type OuterDestructured,
} from "./where-transformer.js";

const SUBQUERY_AGG_METHODS: Record<string, IrSubqueryAggregate["func"]> = {
  count: "COUNT",
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
};

/** Extract the column name from `(p) => p.colName` used as an aggregate arg
 *  (e.g. `.sum(p => p.amount)`). */
function extractSubqueryAggregateColumn(fn: ts.Expression): string | null {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  if (fn.parameters.length !== 1) return null;
  const paramName = fn.parameters[0]?.name;
  if (!paramName || !ts.isIdentifier(paramName)) return null;
  const body = ts.isBlock(fn.body)
    ? fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0])
      ? ((fn.body.statements[0] as ts.ReturnStatement).expression ?? null)
      : null
    : fn.body;
  if (!body) return null;
  if (
    ts.isPropertyAccessExpression(body) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === paramName.text
  ) {
    return body.name.text;
  }
  return null;
}

/**
 * Try to convert `EntityClass.query()[.where(fn)].<aggMethod>(...)` into an
 * IrSubquery with an aggregate. Returns null when the chain doesn't match.
 *
 * `outerParamNames` enables correlation: when the inner where references a
 * row param from the surrounding lambda (e.g. `a.id` where `a` is the
 * outer query's row), passing `["a"]` keeps the resulting IrMember intact
 * so the SQL compiler can resolve it to the outer table alias.
 *
 * Closure-variable references (anything not in innerParams or
 * outerParamNames) still bail via the freeVars check.
 */
/** Result of walking the chain segments between `.query()` and the terminal call. */
interface ChainResult {
  entityExpr: ts.Expression;
  whereIr: IrNode | null;
  innerParamNames: string[];
  outerCorrelatedParams?: string[];
  orderBy?: IrOrderBy[];
  limitNum?: number;
  offsetNum?: number;
  distinctCol?: string;
}

/** Read `.orderBy(arrow, "asc"|"desc"?)` and yield an IrOrderBy entry whose
 *  `expr` is an IrMember on the subquery's own row. */
function extractOrderBySegment(call: ts.CallExpression): IrOrderBy | null {
  if (call.arguments.length < 1 || call.arguments.length > 2) return null;
  const arrow = call.arguments[0];
  if (!arrow || (!ts.isArrowFunction(arrow) && !ts.isFunctionExpression(arrow))) return null;
  const col = extractSubqueryAggregateColumn(arrow as ts.Expression);
  if (!col) return null;

  let direction: "asc" | "desc" = "asc";
  const dirArg = call.arguments[1];
  if (dirArg) {
    if (!ts.isStringLiteral(dirArg)) return null;
    if (dirArg.text !== "asc" && dirArg.text !== "desc") return null;
    direction = dirArg.text;
  }

  const paramName = (arrow as ts.ArrowFunction).parameters[0]?.name;
  const param = paramName && ts.isIdentifier(paramName) ? paramName.text : "p";
  return { expr: { kind: "member", param, path: [col] }, direction };
}

/** Read a numeric-literal arg from `.limit(n)` / `.offset(n)`. Negative numbers
 *  arrive as PrefixUnaryExpression(MinusToken, NumericLiteral); not allowed. */
function extractLiteralNumberArg(call: ts.CallExpression): number | null {
  if (call.arguments.length !== 1) return null;
  const a = call.arguments[0];
  if (a && ts.isNumericLiteral(a)) {
    const n = Number(a.text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Mutable state accumulated while walking the chain, leaf-first. */
interface ChainState {
  whereIr: IrNode | null;
  innerParamNames: string[];
  orderByReversed: IrOrderBy[];
  limitNum?: number;
  offsetNum?: number;
  distinctCol?: string;
}

interface SegmentCtx {
  checker: ts.TypeChecker;
  outerParamNames: string[];
  outerDestructured: OuterDestructured | undefined;
}

/** Per-segment handler. Returns false to abort the walk. */
type SegmentHandler = (state: ChainState, call: ts.CallExpression, ctx: SegmentCtx) => boolean;

const segmentHandlers: Record<string, SegmentHandler> = {
  where(state, call, ctx) {
    if (state.whereIr !== null) return false;
    if (call.arguments.length !== 1) return false;
    const whereFn = call.arguments[0];
    if (!whereFn || (!ts.isArrowFunction(whereFn) && !ts.isFunctionExpression(whereFn)))
      return false;
    for (const p of (whereFn as ts.ArrowFunction).parameters) {
      if (ts.isIdentifier(p.name)) state.innerParamNames.push(p.name.text);
    }
    const parsed = parseWhereArrowToIr(
      whereFn,
      ctx.checker,
      ctx.outerParamNames,
      ctx.outerDestructured,
    );
    if (!parsed || parsed.freeVars.length > 0) return false;
    state.whereIr = parsed.ir;
    return true;
  },
  orderBy(state, call) {
    const entry = extractOrderBySegment(call);
    if (!entry) return false;
    // Walker visits leaf-first, so source-order is the reverse of visit-order.
    state.orderByReversed.push(entry);
    return true;
  },
  limit(state, call) {
    if (state.limitNum !== undefined) return false;
    const n = extractLiteralNumberArg(call);
    if (n === null) return false;
    state.limitNum = n;
    return true;
  },
  offset(state, call) {
    if (state.offsetNum !== undefined) return false;
    const n = extractLiteralNumberArg(call);
    if (n === null) return false;
    state.offsetNum = n;
    return true;
  },
  distinct(state, call) {
    if (state.distinctCol !== undefined) return false;
    if (call.arguments.length !== 1) return false;
    const col = extractSubqueryAggregateColumn(call.arguments[0] as ts.Expression);
    if (!col) return false;
    state.distinctCol = col;
    return true;
  },
};

/** Walk `[.where(fn) | .orderBy(arrow,[dir]) | .limit(n) | .offset(n) | .distinct(arrow)]*`
 *  between `.query()` and the terminal call. Returns null if any segment fails. */
function walkSubqueryChain(
  beforeTerminal: ts.Expression,
  checker: ts.TypeChecker,
  outerParamNames: string[],
  outerDestructured: OuterDestructured | undefined,
): ChainResult | null {
  const state: ChainState = { whereIr: null, innerParamNames: [], orderByReversed: [] };
  const ctx: SegmentCtx = { checker, outerParamNames, outerDestructured };

  let cursor: ts.Expression = beforeTerminal;
  while (
    ts.isCallExpression(cursor) &&
    ts.isPropertyAccessExpression(cursor.expression) &&
    cursor.expression.name.text !== "query"
  ) {
    const handler = segmentHandlers[cursor.expression.name.text];
    if (!handler || !handler(state, cursor, ctx)) return null;
    cursor = cursor.expression.expression;
  }

  if (
    !ts.isCallExpression(cursor) ||
    !ts.isPropertyAccessExpression(cursor.expression) ||
    cursor.expression.name.text !== "query"
  ) {
    return null;
  }

  const orderBy = state.orderByReversed.slice().reverse();
  const result: ChainResult = {
    entityExpr: cursor.expression.expression,
    whereIr: state.whereIr,
    innerParamNames: state.innerParamNames,
  };
  const outerCorrelated = computeOuterCorrelatedParams(
    state.whereIr,
    state.innerParamNames,
    orderBy,
  );
  if (outerCorrelated.length > 0) result.outerCorrelatedParams = outerCorrelated;
  if (orderBy.length > 0) result.orderBy = orderBy;
  if (state.limitNum !== undefined) result.limitNum = state.limitNum;
  if (state.offsetNum !== undefined) result.offsetNum = state.offsetNum;
  if (state.distinctCol !== undefined) result.distinctCol = state.distinctCol;
  return result;
}

export function tryExtractInlineSubqueryAggregate(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  outerParamNames: string[] = [],
  outerDestructured?: OuterDestructured,
): IrSubquery | null {
  if (!ts.isCallExpression(expr)) return null;
  if (!ts.isPropertyAccessExpression(expr.expression)) return null;

  const methodName = expr.expression.name.text;
  const aggFunc = SUBQUERY_AGG_METHODS[methodName];
  if (!aggFunc) return null;

  let valueCol: string | undefined;
  if (aggFunc === "COUNT") {
    if (expr.arguments.length !== 0) return null;
  } else {
    if (expr.arguments.length !== 1) return null;
    const col = extractSubqueryAggregateColumn(expr.arguments[0] as ts.Expression);
    if (!col) return null;
    valueCol = col;
  }

  const chain = walkSubqueryChain(
    expr.expression.expression,
    checker,
    outerParamNames,
    outerDestructured,
  );
  if (!chain) return null;

  const tableName = extractTableName(chain.entityExpr, checker);
  if (!tableName) return null;

  const aggregate: IrSubqueryAggregate = { func: aggFunc };
  if (valueCol !== undefined) aggregate.valueCol = valueCol;
  return assembleIrSubquery(tableName, chain, { aggregate });
}

/** Build an IrSubquery from a chain result and a form-specific head
 *  (`{ selectCol }` or `{ aggregate }`). Used by both the IN form (in
 *  where-transformer.ts) and the aggregate form here, so the two call sites
 *  share the chain → IrSubquery assembly + validation. */
export function assembleIrSubquery(
  tableName: string,
  chain: ChainResult,
  head: { selectCol: string } | { aggregate: IrSubqueryAggregate },
): IrSubquery {
  const sub: IrSubquery = { kind: "subquery", tableName, whereIr: chain.whereIr, ...head };
  if (chain.innerParamNames.length > 0) sub.innerParamNames = chain.innerParamNames;
  if (chain.outerCorrelatedParams && chain.outerCorrelatedParams.length > 0) {
    sub.outerCorrelatedParams = chain.outerCorrelatedParams;
  }
  if (chain.orderBy && chain.orderBy.length > 0) sub.orderBy = chain.orderBy;
  if (chain.limitNum !== undefined) sub.limitNum = chain.limitNum;
  if (chain.offsetNum !== undefined) sub.offsetNum = chain.offsetNum;
  if (chain.distinctCol !== undefined) {
    sub.distinct = "selectCol" in head ? true : { col: chain.distinctCol };
  }
  validateIrSubquery(sub);
  return sub;
}

/** Exported for the IN-form extractor in where-transformer.ts so the same
 *  chain-walking logic covers both subquery shapes. */
export { walkSubqueryChain };
export type { ChainResult };
