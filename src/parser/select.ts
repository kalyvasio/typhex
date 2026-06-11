/**
 * Runtime parsing for `.select()` arrow lambdas: columns, nested relations,
 * aggregates, rest-spread, and relation query chains (`.query().where()`…).
 */

import type * as ESTree from "estree";
import type { IrNode, IrSelect, IrSelectRelation, IrAggregate } from "../ir/types.js";
import { RELATION_QUERY_METHODS } from "../arrow/constants.js";
import type { AcornExpr } from "./acorn-types.js";
import {
  extractArrowBody,
  inferParamNames,
  parseExpressionSource,
  normalizeSelectBodySource,
  sliceNodeSource,
} from "./arrow-source.js";
import {
  isArrowFunctionExpression,
  isCallExpression,
  isIdent,
  isIdentifier,
  isLiteral,
  isMemberExpression,
  isObjectExpression,
  isProperty,
  isSpreadElement,
  isStringLiteral,
  memberObjectExpr,
  objectPropertyValue,
  propertyKeyName,
} from "./acorn-helpers.js";
import { resolveMemberPath } from "./acorn-member.js";
import { parseArrowToIrPredicate, parseExpressionToIr, tryParseAggregate } from "./predicate-walk.js";

export function parseArrowToIrSelect(
  fn: (...args: unknown[]) => unknown,
  paramKeys: string[] = [],
): IrSelect | null {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) return null;

  const paramName = inferParamNames(src)[0] ?? "u";
  const fullSrc = normalizeSelectBodySource(body);

  let expr: AcornExpr;
  try {
    expr = parseExpressionSource(fullSrc);
  } catch {
    return null;
  }

  return parseTopLevelSelectExpression(expr, paramName, fullSrc, paramKeys);
}

function parseTopLevelSelectExpression(
  expr: AcornExpr,
  paramName: string,
  fullSrc: string,
  paramKeys: string[],
): IrSelect | null {
  if (isIdent(expr, paramName)) {
    return { param: paramName, paths: [], aliases: [], rest: true };
  }

  if (isMemberExpression(expr)) {
    return parseSingleColumnSelect(expr, paramName);
  }

  if (isCallExpression(expr)) {
    return parseSingleAggregateSelect(expr, paramName, paramKeys);
  }

  if (isObjectExpression(expr)) {
    return parseSelectObjectLiteral(expr, paramName, fullSrc, paramKeys);
  }

  return parseSingleExpressionSelect(expr, paramName, paramKeys);
}

function parseSingleExpressionSelect(
  expr: AcornExpr,
  paramName: string,
  paramKeys: string[],
): IrSelect | null {
  try {
    const ir = parseExpressionToIr(expr, [paramName], paramKeys);
    if (ir.kind === "member" || ir.kind === "param") return null;
    return {
      param: paramName,
      paths: [],
      aliases: [],
      expressions: [{ expr: ir, alias: "expr" }],
    };
  } catch {
    return null;
  }
}

function parseSingleColumnSelect(
  expr: ESTree.MemberExpression,
  paramName: string,
): IrSelect | null {
  const resolved = resolveMemberPath(expr, [paramName]);
  if (!resolved || resolved.path.length === 0) return null;
  const alias = resolved.path[resolved.path.length - 1];
  return { param: paramName, paths: [resolved.path], aliases: [alias] };
}

function parseSingleAggregateSelect(
  callNode: ESTree.CallExpression,
  paramName: string,
  paramKeys: string[] = [],
): IrSelect | null {
  const parsed = safeParseAggregate(callNode, paramName, paramKeys);
  if (!parsed) return null;

  const alias = parsed.rawName.toLowerCase();
  return {
    param: paramName,
    paths: [],
    aliases: [],
    aggregates: [{ ...parsed.ir, alias }],
  };
}

function safeParseAggregate(
  callNode: ESTree.CallExpression,
  paramName: string,
  paramKeys: string[] = [],
): { ir: IrAggregate; rawName: string } | null {
  try {
    return tryParseAggregate(callNode, [paramName], paramKeys, { strictDistinct: false }, []);
  } catch {
    return null;
  }
}

function parseSelectObjectLiteral(
  obj: ESTree.ObjectExpression,
  paramName: string,
  fullSrc: string,
  paramKeys: string[] = [],
): IrSelect | null {
  const paths: string[][] = [];
  const aliases: string[] = [];
  const relations: IrSelectRelation[] = [];
  const aggregates: IrAggregate[] = [];
  const expressions: Array<{ expr: IrNode; alias: string }> = [];
  let rest = false;

  for (const raw of obj.properties) {
    if (isSpreadElement(raw)) {
      if (!isIdent(raw.argument, paramName)) return null;
      rest = true;
      continue;
    }

    if (!isProperty(raw) || raw.computed) return null;

    const keyName = propertyKeyName(raw.key);
    if (!keyName) return null;

    const value = objectPropertyValue(raw.value);
    if (!value) return null;

    const handled = parseSelectProperty(value, keyName, paramName, fullSrc, paramKeys);
    if (!handled) return null;

    applySelectPropertyResult(handled, keyName, paths, aliases, relations, aggregates, expressions);
  }

  if (paths.length === 0 && relations.length === 0 && aggregates.length === 0 && expressions.length === 0 && !rest) {
    return null;
  }

  const result: IrSelect = { param: paramName, paths, aliases };
  if (relations.length > 0) result.relations = relations;
  if (rest) result.rest = true;
  if (aggregates.length > 0) result.aggregates = aggregates;
  if (expressions.length > 0) result.expressions = expressions;
  return result;
}

type SelectPropertyResult =
  | { kind: "path"; path: string[] }
  | { kind: "relation"; relation: IrSelectRelation }
  | { kind: "aggregate"; aggregate: IrAggregate }
  | { kind: "expression"; expr: IrNode };

function parseSelectProperty(
  value: AcornExpr,
  keyName: string,
  paramName: string,
  fullSrc: string,
  paramKeys: string[] = [],
): SelectPropertyResult | null {
  if (isObjectExpression(value)) {
    return parseNestedRelationProperty(value, keyName, paramName);
  }

  if (isCallExpression(value)) {
    return parseCallSelectProperty(value, keyName, paramName, fullSrc, paramKeys);
  }

  const resolved = resolveMemberPath(value, [paramName]);
  if (resolved && resolved.path.length > 0) {
    return { kind: "path", path: resolved.path };
  }

  try {
    const expr = parseExpressionToIr(value, [paramName], paramKeys);
    if (expr.kind === "member" || expr.kind === "param") return null;
    return { kind: "expression", expr };
  } catch {
    return null;
  }
}

function parseNestedRelationProperty(
  value: ESTree.ObjectExpression,
  keyName: string,
  paramName: string,
): SelectPropertyResult | null {
  const sub = parseRelationSubSelect(value, paramName);
  if (!sub) return null;
  return {
    kind: "relation",
    relation: { name: sub.relation, outputKey: keyName, subPaths: sub.subPaths },
  };
}

function parseCallSelectProperty(
  value: ESTree.CallExpression,
  keyName: string,
  paramName: string,
  fullSrc: string,
  paramKeys: string[] = [],
): SelectPropertyResult | null {
  const parsed = safeParseAggregate(value, paramName, paramKeys);
  if (parsed) {
    return { kind: "aggregate", aggregate: { ...parsed.ir, alias: keyName } };
  }

  const relation = parseRelationQueryChain(value, paramName, keyName, fullSrc);
  if (!relation) return null;
  return { kind: "relation", relation };
}

function applySelectPropertyResult(
  result: SelectPropertyResult,
  keyName: string,
  paths: string[][],
  aliases: string[],
  relations: IrSelectRelation[],
  aggregates: IrAggregate[],
  expressions: Array<{ expr: IrNode; alias: string }>,
): void {
  switch (result.kind) {
    case "path":
      paths.push(result.path);
      aliases.push(keyName);
      return;
    case "relation":
      relations.push(result.relation);
      return;
    case "aggregate":
      aggregates.push(result.aggregate);
      return;
    case "expression":
      expressions.push({ expr: result.expr, alias: keyName });
      return;
  }
}

function parseRelationSubSelect(
  obj: ESTree.ObjectExpression,
  paramName: string,
): { relation: string; subPaths: string[][] } | null {
  const subPaths: string[][] = [];
  let relation: string | null = null;

  for (const raw of obj.properties) {
    if (!isProperty(raw) || raw.computed) return null;

    const keyName = propertyKeyName(raw.key);
    if (!keyName) return null;

    const value = objectPropertyValue(raw.value);
    if (!value) return null;

    const resolved = resolveMemberPath(value, [paramName]);
    if (!resolved || resolved.path.length < 2) return null;

    const rel = resolved.path[0];
    if (relation !== null && relation !== rel) return null;
    relation = rel;
    subPaths.push(resolved.path.slice(1));
  }

  if (!relation || subPaths.length === 0) return null;
  return { relation, subPaths };
}

// ---- Relation query chains --------------------------------------------------

interface ChainMethod {
  name: string;
  args: Array<ESTree.Expression | ESTree.SpreadElement>;
}

function parseRelationQueryChain(
  node: ESTree.CallExpression,
  parentParamName: string,
  outputKey: string,
  source: string,
): IrSelectRelation | null {
  const chain = collectChainMethods(node);
  if (!chain) return null;

  const headPath = resolveMemberPath(chain.head, [parentParamName]);
  if (!headPath || headPath.path.length !== 1) return null;

  const result: IrSelectRelation = { name: headPath.path[0], outputKey };

  for (const method of chain.methods) {
    if (!applyChainMethod(method, result, source)) return null;
  }
  return result;
}

function collectChainMethods(
  node: ESTree.CallExpression,
): { methods: ChainMethod[]; head: ESTree.MemberExpression } | null {
  const methods: ChainMethod[] = [];
  let current: AcornExpr | null = node;

  while (current && isCallExpression(current)) {
    const callee = current.callee;
    if (!isMemberExpression(callee)) return null;

    const methodName = isIdentifier(callee.property) ? callee.property.name : undefined;
    if (!methodName || !RELATION_QUERY_METHODS.has(methodName)) return null;

    methods.push({ name: methodName, args: current.arguments });
    const object = memberObjectExpr(callee);
    if (!object) return null;
    current = object;
  }

  if (!current || !isMemberExpression(current)) return null;
  return { methods, head: current };
}

function applyChainMethod(method: ChainMethod, result: IrSelectRelation, source: string): boolean {
  switch (method.name) {
    case "query":
      return method.args.length === 0;
    case "where":
      return applyWhereMethod(method.args, result, source);
    case "orderBy":
      return applyOrderByMethod(method.args, result);
    case "limit":
      return applyLimitOrOffsetMethod(method.args, result, "limit");
    case "offset":
      return applyLimitOrOffsetMethod(method.args, result, "offset");
    case "select":
      return applySelectMethod(method.args, result, source);
    default:
      return false;
  }
}

function applyWhereMethod(
  args: Array<ESTree.Expression | ESTree.SpreadElement>,
  result: IrSelectRelation,
  source: string,
): boolean {
  if (args.length !== 1 || !isArrowFunctionExpression(args[0])) return false;

  const argSrc = sliceNodeSource(args[0], source);
  if (!argSrc) return false;

  try {
    const whereFn = new Function("return " + argSrc)() as (...args: unknown[]) => unknown;
    const paramNames = inferParamNames(argSrc);
    result.whereIr = parseArrowToIrPredicate(whereFn, { paramNames });
    result.whereParams = {};
    return true;
  } catch {
    return false;
  }
}

function applyOrderByMethod(
  args: Array<ESTree.Expression | ESTree.SpreadElement>,
  result: IrSelectRelation,
): boolean {
  if (args.length < 1 || args.length > 2) return false;

  const colNode = args[0];
  if (!colNode || colNode.type === "SpreadElement" || !isLiteral(colNode)) return false;
  const col = String(colNode.value);
  if (!col) return false;

  const dirArg = args.length === 2 ? args[1] : undefined;
  const dir =
    dirArg && dirArg.type !== "SpreadElement" && isStringLiteral(dirArg) && dirArg.value === "desc"
      ? "desc"
      : "asc";
  result.orderBy = result.orderBy ?? [];
  result.orderBy.push({
    expr: { kind: "member", param: "u", path: [col] },
    direction: dir,
  });
  return true;
}

function applyLimitOrOffsetMethod(
  args: Array<ESTree.Expression | ESTree.SpreadElement>,
  result: IrSelectRelation,
  kind: "limit" | "offset",
): boolean {
  if (args.length !== 1) return false;

  const node = args[0];
  if (!node || node.type === "SpreadElement" || !isLiteral(node)) return false;

  const n = Number(node.value);
  if (!Number.isFinite(n) || n < 0) return false;

  if (kind === "limit") result.limitNum = Math.floor(n);
  else result.offsetNum = Math.floor(n);
  return true;
}

function applySelectMethod(
  args: Array<ESTree.Expression | ESTree.SpreadElement>,
  result: IrSelectRelation,
  source: string,
): boolean {
  if (args.length !== 1 || !isArrowFunctionExpression(args[0])) return false;

  const argSrc = sliceNodeSource(args[0], source);
  if (!argSrc) return false;

  try {
    const selectFn = new Function("return " + argSrc)() as (...args: unknown[]) => unknown;
    const sub = parseArrowToIrSelect(selectFn);
    if (!sub || !sub.paths.length) return false;
    result.subPaths = sub.paths;
    return true;
  } catch {
    return false;
  }
}
