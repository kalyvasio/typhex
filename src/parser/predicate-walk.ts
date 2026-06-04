/**
 * Runtime WHERE/HAVING predicate parsing: acorn expression walk → IR.
 * Includes binary/unary/member/call handling, aggregates, and .some()/.every().
 */

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
  IrWhere,
} from "../ir/types.js";
import {
  DEFAULT_ROW_PARAM,
  ALLOWED_METHODS,
  ACORN_BINARY_OPS,
} from "../arrow/constants.js";
import { AGGREGATE_FUNCS, toIrFuncName } from "../arrow/aggregates.js";
import type { AcornExpr } from "./acorn-types.js";
import { extractArrowBody, inferParamNames, parseExpressionSource } from "./arrow-source.js";
import { isIdent, isLiteral, isStringLiteral } from "./acorn-helpers.js";
import { resolveMemberPath } from "./acorn-member.js";

export interface ParseOptions {
  paramNames?: string[];
  paramKeys?: string[];
  subqueryKeys?: string[];
}

export function parseArrowToIr(
  fn: (...args: unknown[]) => unknown,
  options: ParseOptions = {},
): IrNode {
  return parseArrowToIrPredicate(fn, options).node;
}

export function parseArrowToIrPredicate(
  fn: (...args: unknown[]) => unknown,
  options: ParseOptions = {},
): IrWhere {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) throw new Error("Could not extract arrow body: " + src);

  const expr = parseExpressionSource(body);
  const params = resolveParamsFromOptions(src, options);

  return {
    node: walk(expr, params, options.paramKeys ?? [], options.subqueryKeys ?? []),
    rootParam: params[0] ?? DEFAULT_ROW_PARAM,
    localParamNames: params,
  };
}

function resolveParamsFromOptions(src: string, options: ParseOptions): string[] {
  if (options.paramNames) return options.paramNames;
  return inferParamNames(src);
}

function walk(
  node: AcornExpr,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrNode {
  switch (node.type) {
    case "BinaryExpression":
    case "LogicalExpression":
      return walkBinaryLike(node, params, paramKeys, subqueryKeys);

    case "UnaryExpression":
      return walkUnary(node, params, paramKeys, subqueryKeys);

    case "MemberExpression":
      return walkMember(node, params);

    case "Identifier":
      return walkIdentifier(node, params, paramKeys);

    case "Literal":
      return { kind: "const", value: (node as AcornExpr & { value?: unknown }).value } as IrConst;

    case "CallExpression":
      return walkCall(node, params, paramKeys, subqueryKeys);

    case "ArrayExpression":
      return walkArrayLiteral(node, params, paramKeys, subqueryKeys);

    default:
      throw new Error("Unsupported node type: " + node.type);
  }
}

function walkBinaryLike(
  node: AcornExpr,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrNode {
  const n = node as AcornExpr & { operator?: string; left?: AcornExpr; right?: AcornExpr };
  if (n.operator === "in") {
    const left = walk(n.left as AcornExpr, params, paramKeys, subqueryKeys);
    const rhs = n.right as AcornExpr;
    if (rhs.type === "Identifier") {
      const name = (rhs as AcornExpr & { name?: string }).name ?? "";
      if (subqueryKeys.includes(name)) {
        return { kind: "in", left, right: { kind: "subqueryRef", key: name } } as IrIn;
      }
    }
    const right = walk(rhs, params, paramKeys, subqueryKeys);
    return { kind: "in", left, right } as IrIn;
  }

  const left = walk(n.left as AcornExpr, params, paramKeys, subqueryKeys);
  const right = walk(n.right as AcornExpr, params, paramKeys, subqueryKeys);
  const op = ACORN_BINARY_OPS[n.operator ?? ""];
  if (!op) throw new Error("Unsupported binary operator: " + n.operator);
  return { kind: "binary", op, left, right } as IrBinary;
}

function walkUnary(
  node: AcornExpr,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrNode {
  const n = node as AcornExpr & { operator?: string; argument?: AcornExpr; operand?: AcornExpr };
  if (n.operator !== "!") throw new Error("Unsupported unary: " + n.operator);

  const inner = walk((n.argument ?? n.operand) as AcornExpr, params, paramKeys, subqueryKeys);

  if (inner.kind === "in") return { ...inner, negated: !inner.negated };

  return { kind: "unary", op: "!", operand: inner } as IrUnary;
}

function walkMember(node: AcornExpr, params: string[]): IrMember {
  const resolved = resolveMemberPath(node, params);
  if (!resolved) throw new Error("Unsupported member expression");
  return { kind: "member", param: resolved.param, path: resolved.path };
}

function walkIdentifier(node: AcornExpr, params: string[], paramKeys: string[]): IrNode {
  const name = (node as AcornExpr & { name?: string }).name ?? "";
  if (params.includes(name)) return { kind: "member", param: name, path: [] } as IrMember;
  if (paramKeys.includes(name)) return { kind: "param", key: name } as IrParam;
  throw new Error("Unknown identifier (not param or entity): " + name);
}

function walkArrayLiteral(
  node: AcornExpr,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrConst {
  const arr = node as AcornExpr & { elements?: Array<AcornExpr | null> };
  const values = (arr.elements ?? []).map((e) => {
    if (!e || e.type === "SpreadElement") throw new Error("Unsupported array element");
    const ir = walk(e, params, paramKeys, subqueryKeys);
    if (ir.kind !== "const") throw new Error("IN array must contain literals");
    return ir.value;
  });
  return { kind: "const", value: values };
}

function walkCall(
  node: AcornExpr,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrNode {
  const n = node as AcornExpr & { callee?: AcornExpr; arguments?: AcornExpr[] };
  const callee = n.callee as AcornExpr;

  if (callee.type === "Identifier") {
    const aggregate = tryParseAggregate(
      node,
      params,
      paramKeys,
      { strictDistinct: true },
      subqueryKeys,
    );
    if (aggregate) return aggregate.ir;
    throw new Error("Unsupported call expression");
  }

  if (callee.type !== "MemberExpression") {
    throw new Error("Unsupported call expression");
  }

  const cal = callee as AcornExpr & { property?: AcornExpr; object?: AcornExpr };
  const method = (cal.property as AcornExpr & { name?: string })?.name;

  const exists = tryParseSomeEvery(node, method, params, paramKeys, subqueryKeys);
  if (exists) return exists;

  if (!method || !ALLOWED_METHODS.has(method)) {
    throw new Error("Unsupported method: " + method);
  }
  return {
    kind: "call",
    method,
    receiver: walk(cal.object as AcornExpr, params, paramKeys, subqueryKeys),
    args: ((n.arguments ?? []) as AcornExpr[]).map((a) => walk(a, params, paramKeys, subqueryKeys)),
  } as IrCall;
}

function tryParseSomeEvery(
  node: AcornExpr,
  method: string | undefined,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrExists | null {
  if (method !== "some" && method !== "every") return null;

  const n = node as AcornExpr & { arguments?: AcornExpr[]; callee?: AcornExpr };
  const args = n.arguments ?? [];
  if (args.length !== 1) return null;

  const callee = n.callee as AcornExpr & { object?: AcornExpr };
  const receiver = resolveMemberPath(callee.object as AcornExpr, params);
  if (!receiver || receiver.path.length < 1) return null;

  const cb = args[0];
  if (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression") return null;

  const cbNode = cb as AcornExpr & { params?: AcornExpr[]; body?: AcornExpr };
  const innerParam = ((cbNode.params?.[0] as AcornExpr & { name?: string })?.name as string) ?? "e";
  const innerExpr = extractCallbackExpression(cbNode.body as AcornExpr, method);
  const innerWhere = walk(innerExpr, [innerParam], paramKeys, subqueryKeys);

  return {
    kind: "exists",
    ...(method === "every" ? { negated: true } : {}),
    rootParam: receiver.param,
    relationKey: receiver.path[0],
    innerParam,
    innerWhere,
  } as IrExists;
}

function extractCallbackExpression(body: AcornExpr, method: string): AcornExpr {
  if (body?.type === "BlockStatement") {
    const block = body as AcornExpr & { body?: AcornExpr[] };
    const first = block.body?.[0];
    const expr = (first as AcornExpr & { expression?: AcornExpr })?.expression;
    if (!expr) throw new Error(`Unsupported .${method}() callback: need return`);
    return expr;
  }
  if (!body) throw new Error(`Unsupported .${method}() callback body`);
  return body;
}

interface AggregateParseResult {
  ir: IrAggregate;
  rawName: string;
}

export function tryParseAggregate(
  callNode: AcornExpr,
  params: string[],
  paramKeys: string[],
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): AggregateParseResult | null {
  const n = callNode as AcornExpr & { callee?: AcornExpr; arguments?: AcornExpr[] };
  const callee = n.callee as AcornExpr;
  if (!callee || callee.type !== "Identifier") return null;

  const rawName = (callee as AcornExpr & { name?: string }).name ?? "";
  const funcName = toIrFuncName(rawName);
  if (!AGGREGATE_FUNCS.has(funcName)) return null;

  const args = n.arguments ?? [];
  const { arg, distinct } = parseAggregateArg(
    args[0] ?? null,
    params,
    paramKeys,
    rawName,
    opts,
    subqueryKeys,
  );
  const separator = parseAggregateSeparator(funcName, args);

  const ir: IrAggregate = {
    kind: "aggregate",
    func: funcName as IrAggregate["func"],
    arg,
    ...(distinct ? { distinct: true } : {}),
    ...(separator !== undefined ? { separator } : {}),
  };
  return { ir, rawName };
}

function parseAggregateArg(
  argNode: AcornExpr | null,
  params: string[],
  paramKeys: string[],
  rawName: string,
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): { arg: IrNode | null; distinct: boolean } {
  if (!argNode) return { arg: null, distinct: false };

  const arg = argNode as AcornExpr & { type?: string; callee?: AcornExpr; arguments?: AcornExpr[] };
  if (arg.type === "CallExpression" && isIdent(arg.callee as AcornExpr, "distinct")) {
    return parseDistinctWrapper(arg, params, paramKeys, rawName, opts, subqueryKeys);
  }

  try {
    return { arg: walk(argNode, params, paramKeys, subqueryKeys), distinct: false };
  } catch {
    return { arg: null, distinct: false };
  }
}

function parseDistinctWrapper(
  distinctCall: AcornExpr,
  params: string[],
  paramKeys: string[],
  rawName: string,
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): { arg: IrNode | null; distinct: boolean } {
  const dc = distinctCall as AcornExpr & { arguments?: AcornExpr[] };
  const inner = dc.arguments?.[0];

  if (!inner) {
    if (opts.strictDistinct) {
      throw new Error(
        `Unsupported DISTINCT aggregate expression in ${rawName}(): missing inner argument`,
      );
    }
    return { arg: null, distinct: false };
  }

  try {
    return { arg: walk(inner, params, paramKeys, subqueryKeys), distinct: true };
  } catch {
    if (opts.strictDistinct) {
      throw new Error(
        `Unsupported DISTINCT aggregate expression in ${rawName}(): could not parse distinct(...) argument`,
      );
    }
    return { arg: null, distinct: false };
  }
}

function parseAggregateSeparator(funcName: string, args: AcornExpr[]): string | undefined {
  if (funcName !== "GROUP_CONCAT" && funcName !== "STRING_AGG") return undefined;
  if (args.length < 2) return undefined;
  const sep = args[1];
  return isStringLiteral(sep) ? ((sep as AcornExpr & { value?: string }).value as string) : undefined;
}
