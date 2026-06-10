/**
 * Runtime WHERE/HAVING predicate parsing: acorn expression walk → IR.
 * Includes binary/unary/member/call handling, aggregates, and .some()/.every().
 */

import type * as ESTree from "estree";
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
import { DEFAULT_ROW_PARAM, ALLOWED_METHODS, ACORN_BINARY_OPS } from "../arrow/constants.js";
import { AGGREGATE_FUNCS, toIrFuncName } from "../arrow/aggregates.js";
import type { AcornExpr } from "./acorn-types.js";
import { extractArrowBody, inferParamNames, parseExpressionSource } from "./arrow-source.js";
import {
  extractCallbackExpression,
  firstParamName,
  isArrowFunctionExpression,
  isCallExpression,
  isExpressionNode,
  isFunctionExpression,
  isIdent,
  isIdentifier,
  isMemberExpression,
  isStringLiteral,
  memberObjectExpr,
} from "./acorn-helpers.js";
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
      return { kind: "const", value: node.value } as IrConst;

    case "CallExpression":
      return walkCall(node, params, paramKeys, subqueryKeys);

    case "ArrayExpression":
      return walkArrayLiteral(node, params, paramKeys, subqueryKeys);

    default:
      throw new Error("Unsupported node type: " + node.type);
  }
}

function walkBinaryLike(
  node: ESTree.BinaryExpression | ESTree.LogicalExpression,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrNode {
  if (node.operator === "in") {
    if (!isExpressionNode(node.left)) {
      throw new Error("Unsupported left-hand side of in operator");
    }
    const left = walk(node.left, params, paramKeys, subqueryKeys);
    const rhs = node.right;
    if (isIdentifier(rhs) && subqueryKeys.includes(rhs.name)) {
      return { kind: "in", left, right: { kind: "subqueryRef", key: rhs.name } } as IrIn;
    }
    if (!isExpressionNode(rhs)) {
      throw new Error("Unsupported right-hand side of in operator");
    }
    const right = walk(rhs, params, paramKeys, subqueryKeys);
    return { kind: "in", left, right } as IrIn;
  }

  if (!isExpressionNode(node.left) || !isExpressionNode(node.right)) {
    throw new Error("Unsupported binary operand");
  }
  const left = walk(node.left, params, paramKeys, subqueryKeys);
  const right = walk(node.right, params, paramKeys, subqueryKeys);
  const op = ACORN_BINARY_OPS[node.operator];
  if (!op) throw new Error("Unsupported binary operator: " + node.operator);
  return { kind: "binary", op, left, right } as IrBinary;
}

function walkUnary(
  node: ESTree.UnaryExpression,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrNode {
  if (node.operator !== "!") throw new Error("Unsupported unary: " + node.operator);

  const inner = walk(node.argument, params, paramKeys, subqueryKeys);

  if (inner.kind === "in") return { ...inner, negated: !inner.negated };

  return { kind: "unary", op: "!", operand: inner } as IrUnary;
}

function walkMember(node: ESTree.MemberExpression, params: string[]): IrMember {
  const resolved = resolveMemberPath(node, params);
  if (!resolved) throw new Error("Unsupported member expression");
  return { kind: "member", param: resolved.param, path: resolved.path };
}

function walkIdentifier(node: ESTree.Identifier, params: string[], paramKeys: string[]): IrNode {
  if (params.includes(node.name)) return { kind: "member", param: node.name, path: [] } as IrMember;
  if (paramKeys.includes(node.name)) return { kind: "param", key: node.name } as IrParam;
  throw new Error("Unknown identifier (not param or entity): " + node.name);
}

function walkArrayLiteral(
  node: ESTree.ArrayExpression,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrConst {
  const values = node.elements.map((e) => {
    if (!e || e.type === "SpreadElement") throw new Error("Unsupported array element");
    const ir = walk(e, params, paramKeys, subqueryKeys);
    if (ir.kind !== "const") throw new Error("IN array must contain literals");
    return ir.value;
  });
  return { kind: "const", value: values };
}

function walkCall(
  node: ESTree.CallExpression,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrNode {
  const callee = node.callee;

  if (isIdentifier(callee)) {
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

  if (!isMemberExpression(callee)) {
    throw new Error("Unsupported call expression");
  }

  const method = isIdentifier(callee.property) ? callee.property.name : undefined;

  const exists = tryParseSomeEvery(node, method, params, paramKeys, subqueryKeys);
  if (exists) return exists;

  if (!method || !ALLOWED_METHODS.has(method)) {
    throw new Error("Unsupported method: " + method);
  }
  const receiver = memberObjectExpr(callee);
  if (!receiver) throw new Error("Unsupported call receiver");

  return {
    kind: "call",
    method,
    receiver: walk(receiver, params, paramKeys, subqueryKeys),
    args: node.arguments.map((a) => {
      if (a.type === "SpreadElement") throw new Error("Unsupported spread argument");
      return walk(a, params, paramKeys, subqueryKeys);
    }),
  } as IrCall;
}

function tryParseSomeEvery(
  node: ESTree.CallExpression,
  method: string | undefined,
  params: string[],
  paramKeys: string[],
  subqueryKeys: string[],
): IrExists | null {
  if (method !== "some" && method !== "every") return null;
  if (node.arguments.length !== 1) return null;
  if (!isMemberExpression(node.callee)) return null;

  const calleeObject = memberObjectExpr(node.callee);
  if (!calleeObject) return null;

  const receiver = resolveMemberPath(calleeObject, params);
  if (!receiver || receiver.path.length < 1) return null;

  const cb = node.arguments[0];
  if (!isArrowFunctionExpression(cb) && !isFunctionExpression(cb)) return null;

  const innerParam = firstParamName(cb.params) ?? "e";
  const innerExpr = extractCallbackExpression(cb.body, method);
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

interface AggregateParseResult {
  ir: IrAggregate;
  rawName: string;
}

export function tryParseAggregate(
  callNode: ESTree.CallExpression,
  params: string[],
  paramKeys: string[],
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): AggregateParseResult | null {
  const callee = callNode.callee;
  if (!isIdentifier(callee)) return null;

  const rawName = callee.name;
  const funcName = toIrFuncName(rawName);
  if (!AGGREGATE_FUNCS.has(funcName)) return null;

  const { arg, distinct } = parseAggregateArg(
    callNode.arguments[0] ?? null,
    params,
    paramKeys,
    rawName,
    opts,
    subqueryKeys,
  );
  const separator = parseAggregateSeparator(funcName, callNode.arguments);

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
  argNode: ESTree.Expression | ESTree.SpreadElement | null,
  params: string[],
  paramKeys: string[],
  rawName: string,
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): { arg: IrNode | null; distinct: boolean } {
  if (!argNode || argNode.type === "SpreadElement") return { arg: null, distinct: false };

  if (isCallExpression(argNode) && isIdent(argNode.callee, "distinct")) {
    return parseDistinctWrapper(argNode, params, paramKeys, rawName, opts, subqueryKeys);
  }

  try {
    return { arg: walk(argNode, params, paramKeys, subqueryKeys), distinct: false };
  } catch {
    return { arg: null, distinct: false };
  }
}

function parseDistinctWrapper(
  distinctCall: ESTree.CallExpression,
  params: string[],
  paramKeys: string[],
  rawName: string,
  opts: { strictDistinct: boolean },
  subqueryKeys: string[],
): { arg: IrNode | null; distinct: boolean } {
  const inner = distinctCall.arguments[0];
  if (!inner || inner.type === "SpreadElement") {
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

function parseAggregateSeparator(
  funcName: string,
  args: Array<ESTree.Expression | ESTree.SpreadElement>,
): string | undefined {
  if (funcName !== "GROUP_CONCAT" && funcName !== "STRING_AGG") return undefined;
  if (args.length < 2) return undefined;
  const sep = args[1];
  return sep && sep.type !== "SpreadElement" && isStringLiteral(sep) ? sep.value : undefined;
}
