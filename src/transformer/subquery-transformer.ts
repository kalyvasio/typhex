/**
 * Detect inline `Entity.query()[.where(fn)].<aggMethod>(...)` chains in TS
 * source and convert them to IrSubquery nodes with `aggregate` set.
 *
 * Lives in its own module so both select-transformer (for SELECT-list
 * subquery columns) and where-transformer (for binary aggregate-comparison
 * filters) can import it without a circular dependency.
 */

import * as ts from "typescript";
import type {
  IrNode,
  IrBinary,
  IrUnary,
  IrMember,
  IrConst,
  IrParam,
  IrIn,
  IrCall,
  IrExists,
  IrAggregate,
  IrOrderBy,
  IrSelect,
  IrSubquery,
} from "../ir/types.js";
import { computeOuterCorrelatedParams, validateIrSubquery } from "../ir/types.js";
import {
  parseWhereArrowToIr,
  extractTableName,
  type OuterDestructured,
} from "./where-transformer.js";
import { parseTsAggregateCall, type ScopeFrame } from "./shared.js";

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

/** Read `.orderBy(...)` and yield an IrOrderBy entry. Accepts either:
 *   - a raw arrow `(p) => p.col` plus optional direction string (legacy /
 *     runtime-parser path), or
 *   - an already-rewritten IrOrderBy object literal (post inside-out, when
 *     `transformOrderByCall` produced the literal first). */
function extractOrderBySegment(call: ts.CallExpression): IrOrderBy | null {
  if (call.arguments.length < 1) return null;
  const arg = call.arguments[0];
  if (!arg) return null;

  // Post inside-out: arg is `{ expr: <IR>, direction: "asc"|"desc" }`
  if (ts.isObjectLiteralExpression(arg)) {
    return readOrderByLiteral(arg);
  }

  // Legacy: arg is an arrow `(p) => p.col`; optional `direction` string follows.
  if (call.arguments.length > 2) return null;
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return null;
  const col = extractSubqueryAggregateColumn(arg as ts.Expression);
  if (!col) return null;

  let direction: "asc" | "desc" = "asc";
  const dirArg = call.arguments[1];
  if (dirArg) {
    if (!ts.isStringLiteral(dirArg)) return null;
    if (dirArg.text !== "asc" && dirArg.text !== "desc") return null;
    direction = dirArg.text;
  }

  const paramName = (arg as ts.ArrowFunction).parameters[0]?.name;
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
  outerScope: ScopeFrame[];
}

/** Per-segment handler. Returns false to abort the walk. */
type SegmentHandler = (state: ChainState, call: ts.CallExpression, ctx: SegmentCtx) => boolean;

const segmentHandlers: Record<string, SegmentHandler> = {
  where(state, call, ctx) {
    if (state.whereIr !== null) return false;
    if (call.arguments.length < 1) return false;
    const arg = call.arguments[0];
    if (!arg) return false;

    // Post inside-out rewrite: arg is a serialized IrNode object literal
    // (the inner `.where(arrow)` was already transformed by transformWhereCall,
    // with outer-scope identifiers correctly resolved via the scope stack).
    if (ts.isObjectLiteralExpression(arg)) {
      const ir = objectLiteralToIrNode(arg);
      if (!ir) return false;
      state.whereIr = ir;
      // Recover inner param names from the IR: any IrMember.param not in the
      // outer scope is an inner-arrow binding.
      const referenced = collectMemberParams(ir);
      const outerNames = new Set<string>(ctx.outerParamNames);
      for (const frame of ctx.outerScope) outerNames.add(frame.paramName);
      for (const name of referenced) {
        if (!outerNames.has(name) && !state.innerParamNames.includes(name)) {
          state.innerParamNames.push(name);
        }
      }
      return true;
    }

    // Legacy / outside-in path: the arg is still an arrow (e.g. when the
    // chain walker is invoked from a context where transformWhereCall hasn't
    // run yet, like the runtime-parser side of subquery extraction).
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      for (const p of (arg as ts.ArrowFunction).parameters) {
        if (ts.isIdentifier(p.name)) state.innerParamNames.push(p.name.text);
      }
      const parsed = parseWhereArrowToIr(
        arg,
        ctx.checker,
        ctx.outerParamNames,
        ctx.outerDestructured,
        ctx.outerScope,
      );
      if (!parsed || parsed.freeVars.length > 0) return false;
      state.whereIr = parsed.ir;
      return true;
    }
    return false;
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
  outerScope: ScopeFrame[] = [],
): ChainResult | null {
  const state: ChainState = { whereIr: null, innerParamNames: [], orderByReversed: [] };
  const ctx: SegmentCtx = { checker, outerParamNames, outerDestructured, outerScope };

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

/** Try to recognize a chain that ends in `.select(<arrow>)` whose arrow
 *  produces an aggregate or a single member-path projection. Returns the
 *  IrSelect when extractable. Accepts either an already-rewritten object
 *  literal (post select-transformer) or a fresh arrow function — the visitor
 *  may reach this code from an outside-in early rewrite, before the inner
 *  `.select(...)` has been transformed. */
function extractSubquerySelectIr(expr: ts.Expression): IrSelect | null {
  if (!ts.isCallExpression(expr)) return null;
  if (!ts.isPropertyAccessExpression(expr.expression)) return null;
  if (expr.expression.name.text !== "select") return null;
  if (expr.arguments.length !== 1) return null;
  const arg = expr.arguments[0];
  if (!arg) return null;

  if (ts.isObjectLiteralExpression(arg)) return objectLiteralToIrSelect(arg);
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    return arrowToSubquerySelectIr(arg);
  }
  return null;
}

/** Lift the inner `.select(<arrow>)` arrow into an IrSelect for subquery use.
 *  Supports the two single-column shapes that compile cleanly through the
 *  subquery dialect path: `(p) => p.col` and `(p) => agg(p.col)` / `() => count()`. */
function arrowToSubquerySelectIr(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): IrSelect | null {
  const paramName =
    fn.parameters[0]?.name && ts.isIdentifier(fn.parameters[0].name)
      ? fn.parameters[0].name.text
      : "p";
  const body = ts.isBlock(fn.body)
    ? fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0])
      ? ((fn.body.statements[0] as ts.ReturnStatement).expression ?? null)
      : null
    : fn.body;
  if (!body) return null;

  // (p) => p.col  →  single-path projection
  if (
    ts.isPropertyAccessExpression(body) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === paramName
  ) {
    return { param: paramName, paths: [[body.name.text]], aliases: [body.name.text] };
  }

  // (p) => count(p.id) / () => count() / (p) => sum(p.amount)
  if (ts.isCallExpression(body)) {
    const parsed = parseTsAggregateCall(body, [paramName]);
    if (!parsed) return null;
    const alias = parsed.rawName.toLowerCase();
    return {
      param: paramName,
      paths: [],
      aliases: [],
      aggregates: [{ ...parsed.ir, alias }],
    };
  }

  return null;
}

/** Lift a `{ param: "p", paths: [["id"]], ... }` object literal back to an
 *  IrSelect at compile time. Reads only the fields we need to round-trip
 *  through the dialect: param, paths, aliases, aggregates. */
function objectLiteralToIrSelect(node: ts.Expression): IrSelect | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const select: IrSelect = { param: "p", paths: [] };
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) return null;
    if (!ts.isIdentifier(prop.name)) return null;
    const key = prop.name.text;
    const value = prop.initializer;
    switch (key) {
      case "param":
        if (!ts.isStringLiteral(value)) return null;
        select.param = value.text;
        break;
      case "paths": {
        const paths = readStringPathArray(value);
        if (!paths) return null;
        select.paths = paths;
        break;
      }
      case "aliases": {
        const aliases = readStringArray(value);
        if (!aliases) return null;
        select.aliases = aliases;
        break;
      }
      case "rest":
        select.rest = value.kind === ts.SyntaxKind.TrueKeyword;
        break;
      case "aggregates": {
        if (!ts.isArrayLiteralExpression(value)) return null;
        const aggs: IrAggregate[] = [];
        for (const el of value.elements) {
          if (!ts.isObjectLiteralExpression(el)) return null;
          const agg = readAggregateLiteral(el);
          if (!agg) return null;
          aggs.push(agg);
        }
        select.aggregates = aggs;
        break;
      }
      default:
        // Unknown field — bail to be safe rather than silently dropping data.
        return null;
    }
  }
  return select;
}

function readStringArray(node: ts.Expression): string[] | null {
  if (!ts.isArrayLiteralExpression(node)) return null;
  const out: string[] = [];
  for (const el of node.elements) {
    if (!ts.isStringLiteral(el)) return null;
    out.push(el.text);
  }
  return out;
}

function readStringPathArray(node: ts.Expression): string[][] | null {
  if (!ts.isArrayLiteralExpression(node)) return null;
  const out: string[][] = [];
  for (const el of node.elements) {
    const arr = readStringArray(el);
    if (!arr) return null;
    out.push(arr);
  }
  return out;
}

/** Read a TS object literal previously emitted by `irNodeToTsLiteral` back
 *  into the corresponding IrNode JS object. Returns null on shape mismatch. */
function objectLiteralToIrNode(node: ts.Expression): IrNode | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const props = readPropertyMap(node);
  const kind = readStringProp(props, "kind");
  if (!kind) return null;
  switch (kind) {
    case "binary": {
      const op = readStringProp(props, "op") as IrBinary["op"] | undefined;
      const leftN = props.get("left");
      const rightN = props.get("right");
      if (!op || !leftN || !rightN) return null;
      const left = objectLiteralToIrNode(leftN);
      const right = objectLiteralToIrNode(rightN);
      if (!left || !right) return null;
      return { kind: "binary", op, left, right } satisfies IrBinary;
    }
    case "unary": {
      const op = readStringProp(props, "op") as IrUnary["op"] | undefined;
      const operandN = props.get("operand");
      if (!op || !operandN) return null;
      const operand = objectLiteralToIrNode(operandN);
      if (!operand) return null;
      return { kind: "unary", op, operand } satisfies IrUnary;
    }
    case "member": {
      const param = readStringProp(props, "param");
      const pathN = props.get("path");
      if (param === undefined || !pathN) return null;
      const path = readStringArray(pathN);
      if (!path) return null;
      return { kind: "member", param, path } satisfies IrMember;
    }
    case "const": {
      const valueN = props.get("value");
      if (valueN === undefined) return null;
      const value = readJsonValue(valueN);
      return { kind: "const", value } satisfies IrConst;
    }
    case "param": {
      const key = readStringProp(props, "key");
      if (key === undefined) return null;
      return { kind: "param", key } satisfies IrParam;
    }
    case "in": {
      const leftN = props.get("left");
      const rightN = props.get("right");
      if (!leftN || !rightN) return null;
      const left = objectLiteralToIrNode(leftN);
      const right = objectLiteralToIrNode(rightN);
      if (!left || !right) return null;
      const negated = readBoolProp(props, "negated");
      const irIn: IrIn = { kind: "in", left, right };
      if (negated) irIn.negated = true;
      return irIn;
    }
    case "call": {
      const method = readStringProp(props, "method");
      const receiverN = props.get("receiver");
      const argsN = props.get("args");
      if (!method || !receiverN || !argsN || !ts.isArrayLiteralExpression(argsN)) return null;
      const receiver = objectLiteralToIrNode(receiverN);
      if (!receiver) return null;
      const args: IrNode[] = [];
      for (const el of argsN.elements) {
        const a = objectLiteralToIrNode(el);
        if (!a) return null;
        args.push(a);
      }
      return { kind: "call", method, receiver, args } satisfies IrCall;
    }
    case "exists": {
      const rootParam = readStringProp(props, "rootParam");
      const relationKey = readStringProp(props, "relationKey");
      const innerParam = readStringProp(props, "innerParam");
      const innerWhereN = props.get("innerWhere");
      if (!rootParam || !relationKey || !innerParam || !innerWhereN) return null;
      const innerWhere = objectLiteralToIrNode(innerWhereN);
      if (!innerWhere) return null;
      const negated = readBoolProp(props, "negated");
      const ex: IrExists = { kind: "exists", rootParam, relationKey, innerParam, innerWhere };
      if (negated) ex.negated = true;
      return ex;
    }
    case "aggregate": {
      const func = readStringProp(props, "func") as IrAggregate["func"] | undefined;
      if (!func) return null;
      const argN = props.get("arg");
      let arg: IrNode | null = null;
      if (argN && argN.kind !== ts.SyntaxKind.NullKeyword) {
        const parsed = objectLiteralToIrNode(argN);
        if (!parsed) return null;
        arg = parsed;
      }
      const agg: IrAggregate = { kind: "aggregate", func, arg };
      const alias = readStringProp(props, "alias");
      if (alias !== undefined) agg.alias = alias;
      const distinct = readBoolProp(props, "distinct");
      if (distinct) agg.distinct = true;
      const separator = readStringProp(props, "separator");
      if (separator !== undefined) agg.separator = separator;
      return agg;
    }
    default:
      return null;
  }
}

/** Build a map from property name → initializer expression. */
function readPropertyMap(node: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue;
    out.set(prop.name.text, prop.initializer);
  }
  return out;
}

function readStringProp(props: Map<string, ts.Expression>, key: string): string | undefined {
  const v = props.get(key);
  if (v && ts.isStringLiteral(v)) return v.text;
  return undefined;
}

function readBoolProp(props: Map<string, ts.Expression>, key: string): boolean {
  const v = props.get(key);
  return v?.kind === ts.SyntaxKind.TrueKeyword;
}

/** Decode a value emitted by valueToTsExpression: string/number/boolean/null/array/JSON-stringified. */
function readJsonValue(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node)) {
    // Could be a literal string OR a JSON-stringified fallback for objects.
    // Try JSON.parse first; on failure, return the raw text.
    try {
      return JSON.parse(node.text);
    } catch {
      return node.text;
    }
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el) => readJsonValue(el));
  }
  return undefined;
}

/** Recursively collect every IrMember.param name referenced anywhere in `ir`. */
function collectMemberParams(ir: IrNode): Set<string> {
  const out = new Set<string>();
  walk(ir);
  return out;

  function walk(n: IrNode): void {
    switch (n.kind) {
      case "member":
        out.add(n.param);
        break;
      case "binary":
        walk(n.left);
        walk(n.right);
        break;
      case "unary":
        walk(n.operand);
        break;
      case "in":
        walk(n.left);
        // Don't descend into a subquery RHS — its params are inner to it.
        if (n.right.kind !== "subquery") walk(n.right);
        break;
      case "call":
        walk(n.receiver);
        for (const a of n.args) walk(a);
        break;
      case "exists":
        out.add(n.rootParam);
        break;
      case "aggregate":
        if (n.arg) walk(n.arg);
        break;
      default:
        break;
    }
  }
}

/** Read a serialized IrAggregate object literal back into the runtime IR. */
function readAggregateLiteral(node: ts.ObjectLiteralExpression): IrAggregate | null {
  const ir = objectLiteralToIrNode(node);
  if (!ir || ir.kind !== "aggregate") return null;
  return ir;
}

/** Read a serialized IrOrderBy object literal back into the runtime IR. */
function readOrderByLiteral(node: ts.ObjectLiteralExpression): IrOrderBy | null {
  const props = readPropertyMap(node);
  const exprN = props.get("expr");
  const dir = readStringProp(props, "direction");
  if (!exprN || (dir !== "asc" && dir !== "desc")) return null;
  const expr = objectLiteralToIrNode(exprN);
  if (!expr) return null;
  return { expr, direction: dir };
}

/** Try to convert `EntityClass.query()[chain].select(<irSelectLiteral>)` into
 *  an IrSubquery. Returns null when the chain doesn't match. */
export function tryExtractInlineSubqueryAggregate(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  outerParamNames: string[] = [],
  outerDestructured?: OuterDestructured,
  outerScope: ScopeFrame[] = [],
): IrSubquery | null {
  const selectIr = extractSubquerySelectIr(expr);
  if (!selectIr) return null;
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return null;

  const chain = walkSubqueryChain(
    expr.expression.expression,
    checker,
    outerParamNames,
    outerDestructured,
    outerScope,
  );
  if (!chain) return null;

  const tableName = extractTableName(chain.entityExpr, checker);
  if (!tableName) return null;

  return assembleIrSubquery(tableName, chain, selectIr);
}

/** Build an IrSubquery from a chain result and the inner `.select(...)`'s
 *  IrSelect projection. Used by both the IN form (in where-transformer.ts)
 *  and the aggregate-projection form here, so the two call sites share the
 *  chain → IrSubquery assembly + validation. */
export function assembleIrSubquery(
  tableName: string,
  chain: ChainResult,
  selectIr: IrSelect,
): IrSubquery {
  const sub: IrSubquery = { kind: "subquery", tableName, selectIr, whereIr: chain.whereIr };
  if (chain.innerParamNames.length > 0) sub.innerParamNames = chain.innerParamNames;
  if (chain.outerCorrelatedParams && chain.outerCorrelatedParams.length > 0) {
    sub.outerCorrelatedParams = chain.outerCorrelatedParams;
  }
  if (chain.orderBy && chain.orderBy.length > 0) sub.orderBy = chain.orderBy;
  if (chain.limitNum !== undefined) sub.limitNum = chain.limitNum;
  if (chain.offsetNum !== undefined) sub.offsetNum = chain.offsetNum;
  if (chain.distinctCol !== undefined) {
    // Aggregate projection → DISTINCT col argument; path projection → SELECT DISTINCT.
    sub.distinct =
      selectIr.aggregates && selectIr.aggregates.length > 0
        ? { col: chain.distinctCol }
        : true;
  }
  validateIrSubquery(sub);
  return sub;
}

/** Exported for the IN-form extractor in where-transformer.ts so the same
 *  chain-walking logic covers both subquery shapes. */
export { walkSubqueryChain, extractSubquerySelectIr };
export type { ChainResult };
