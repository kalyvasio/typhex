/**
 * Runtime parsing for `.select()` arrow lambdas: columns, nested relations,
 * aggregates, rest-spread, and relation query chains (`.query().where()`…).
 */

import type { IrSelect, IrSelectRelation, IrAggregate } from "../ir/types.js";
import { RELATION_QUERY_METHODS } from "../arrow/constants.js";
import type { AcornExpr } from "./acorn-types.js";
import {
  extractArrowBody,
  inferParamNames,
  parseExpressionSource,
  normalizeSelectBodySource,
  sliceNodeSource,
} from "./arrow-source.js";
import { isIdent, isLiteral } from "./acorn-helpers.js";
import { resolveMemberPath } from "./acorn-member.js";
import { parseArrowToIrPredicate, tryParseAggregate } from "./predicate-walk.js";

export function parseArrowToIrSelect(fn: (...args: unknown[]) => unknown): IrSelect | null {
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

  return parseTopLevelSelectExpression(expr, paramName, fullSrc);
}

function parseTopLevelSelectExpression(
  expr: AcornExpr,
  paramName: string,
  fullSrc: string,
): IrSelect | null {
  if (isIdent(expr, paramName)) {
    return { param: paramName, paths: [], aliases: [], rest: true };
  }

  if (expr.type === "MemberExpression") {
    return parseSingleColumnSelect(expr, paramName);
  }

  if (expr.type === "CallExpression") {
    return parseSingleAggregateSelect(expr, paramName);
  }

  if (expr.type === "ObjectExpression") {
    return parseSelectObjectLiteral(expr, paramName, fullSrc);
  }

  return null;
}

function parseSingleColumnSelect(expr: AcornExpr, paramName: string): IrSelect | null {
  const resolved = resolveMemberPath(expr, [paramName]);
  if (!resolved || resolved.path.length === 0) return null;
  const alias = resolved.path[resolved.path.length - 1];
  return { param: paramName, paths: [resolved.path], aliases: [alias] };
}

function parseSingleAggregateSelect(callNode: AcornExpr, paramName: string): IrSelect | null {
  const parsed = safeParseAggregate(callNode, paramName);
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
  callNode: AcornExpr,
  paramName: string,
): { ir: IrAggregate; rawName: string } | null {
  try {
    return tryParseAggregate(callNode, [paramName], [], { strictDistinct: false }, []);
  } catch {
    return null;
  }
}

function parseSelectObjectLiteral(
  obj: AcornExpr,
  paramName: string,
  fullSrc: string,
): IrSelect | null {
  const o = obj as AcornExpr & { properties?: AcornExpr[] };
  const paths: string[][] = [];
  const aliases: string[] = [];
  const relations: IrSelectRelation[] = [];
  const aggregates: IrAggregate[] = [];
  let rest = false;

  for (const raw of o.properties ?? []) {
    if (raw.type === "SpreadElement") {
      const spread = raw as AcornExpr & { argument?: AcornExpr };
      if (!isIdent(spread.argument as AcornExpr, paramName)) return null;
      rest = true;
      continue;
    }

    const prop = raw as AcornExpr & {
      type?: string;
      computed?: boolean;
      key?: AcornExpr;
      value?: AcornExpr;
    };
    if (prop.type !== "Property" || prop.computed) return null;

    const keyNode = prop.key;
    const keyName =
      (keyNode as AcornExpr & { name?: string })?.name ??
      (keyNode as AcornExpr & { value?: unknown })?.value;
    if (typeof keyName !== "string") return null;

    const value = prop.value;
    if (!value) return null;

    const handled = parseSelectProperty(value, keyName, paramName, fullSrc);
    if (!handled) return null;

    applySelectPropertyResult(handled, keyName, paths, aliases, relations, aggregates);
  }

  if (paths.length === 0 && relations.length === 0 && aggregates.length === 0 && !rest) {
    return null;
  }

  const result: IrSelect = { param: paramName, paths, aliases };
  if (relations.length > 0) result.relations = relations;
  if (rest) result.rest = true;
  if (aggregates.length > 0) result.aggregates = aggregates;
  return result;
}

type SelectPropertyResult =
  | { kind: "path"; path: string[] }
  | { kind: "relation"; relation: IrSelectRelation }
  | { kind: "aggregate"; aggregate: IrAggregate };

function parseSelectProperty(
  value: AcornExpr,
  keyName: string,
  paramName: string,
  fullSrc: string,
): SelectPropertyResult | null {
  if (value.type === "ObjectExpression") {
    return parseNestedRelationProperty(value, keyName, paramName);
  }

  if (value.type === "CallExpression") {
    return parseCallSelectProperty(value, keyName, paramName, fullSrc);
  }

  const resolved = resolveMemberPath(value, [paramName]);
  if (!resolved || resolved.path.length === 0) return null;
  return { kind: "path", path: resolved.path };
}

function parseNestedRelationProperty(
  value: AcornExpr,
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
  value: AcornExpr,
  keyName: string,
  paramName: string,
  fullSrc: string,
): SelectPropertyResult | null {
  const parsed = safeParseAggregate(value, paramName);
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
  }
}

function parseRelationSubSelect(
  obj: AcornExpr,
  paramName: string,
): { relation: string; subPaths: string[][] } | null {
  const o = obj as AcornExpr & { properties?: AcornExpr[] };
  const subPaths: string[][] = [];
  let relation: string | null = null;

  for (const raw of o.properties ?? []) {
    const prop = raw as AcornExpr & {
      type?: string;
      computed?: boolean;
      key?: AcornExpr;
      value?: AcornExpr;
    };
    if (prop.type !== "Property" || prop.computed) return null;

    const keyName =
      (prop.key as AcornExpr & { name?: string })?.name ??
      (prop.key as AcornExpr & { value?: unknown })?.value;
    if (typeof keyName !== "string") return null;

    const value = prop.value;
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
  args: AcornExpr[];
}

function parseRelationQueryChain(
  node: AcornExpr,
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

function collectChainMethods(node: AcornExpr): { methods: ChainMethod[]; head: AcornExpr } | null {
  const methods: ChainMethod[] = [];
  let current: AcornExpr | null = node;

  while (current && current.type === "CallExpression") {
    const n = current as AcornExpr & { callee?: AcornExpr; arguments?: AcornExpr[] };
    const callee = n.callee as AcornExpr;
    if (!callee || callee.type !== "MemberExpression") return null;

    const cal = callee as AcornExpr & { property?: AcornExpr; object?: AcornExpr };
    const methodName = (cal.property as AcornExpr & { name?: string })?.name;
    if (!methodName || !RELATION_QUERY_METHODS.has(methodName)) return null;

    methods.push({ name: methodName, args: n.arguments ?? [] });
    current = cal.object as AcornExpr;
  }

  if (!current || current.type !== "MemberExpression") return null;
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

function applyWhereMethod(args: AcornExpr[], result: IrSelectRelation, source: string): boolean {
  if (args.length !== 1 || args[0].type !== "ArrowFunctionExpression") return false;

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

function applyOrderByMethod(args: AcornExpr[], result: IrSelectRelation): boolean {
  if (args.length < 1 || args.length > 2) return false;

  const colNode = args[0];
  if (!isLiteral(colNode)) return false;
  const col = String((colNode as AcornExpr & { value?: unknown }).value);
  if (!col) return false;

  const dir =
    args.length === 2 && (args[1] as AcornExpr & { value?: unknown }).value === "desc"
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
  args: AcornExpr[],
  result: IrSelectRelation,
  kind: "limit" | "offset",
): boolean {
  if (args.length !== 1) return false;

  const node = args[0];
  if (!isLiteral(node)) return false;

  const n = Number((node as AcornExpr & { value?: unknown }).value);
  if (!Number.isFinite(n) || n < 0) return false;

  if (kind === "limit") result.limitNum = Math.floor(n);
  else result.offsetNum = Math.floor(n);
  return true;
}

function applySelectMethod(args: AcornExpr[], result: IrSelectRelation, source: string): boolean {
  if (args.length !== 1 || args[0].type !== "ArrowFunctionExpression") return false;

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
