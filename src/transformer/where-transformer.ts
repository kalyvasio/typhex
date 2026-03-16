/**
 * Transformer for .where() calls: converts arrow predicates to IR.
 */

import * as ts from "typescript";
import type { IrNode, IrAggregate } from "../ir/types.js";
import {
  isTyphexType,
  resolveMemberPath,
  binaryOpFromSyntaxKind,
  irNodeToTsLiteral,
} from "./shared.js";

const AGGREGATE_FUNCS = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT", "GROUP_CONCAT", "STRING_AGG", "ARRAY_AGG", "JSON_AGG"]);

function toIrFuncName(rawName: string): string {
  const lower = rawName.toLowerCase();
  if (lower === "groupconcat") return "GROUP_CONCAT";
  if (lower === "stringagg")   return "STRING_AGG";
  if (lower === "arrayagg")    return "ARRAY_AGG";
  if (lower === "jsonagg")     return "JSON_AGG";
  return rawName.toUpperCase();
}

const ALLOWED_METHODS = new Set(["startsWith", "endsWith", "includes"]);

/**
 * Convert a TS expression to IR. Returns null for unsupported expressions
 * (the transformer silently skips them; the runtime parser can still handle them).
 */
function exprToIr(
  expr: ts.Expression,
  paramNames: string[],
  freeVars: Set<string>
): IrNode | null {
  if (ts.isParenthesizedExpression(expr)) {
    return exprToIr(expr.expression, paramNames, freeVars);
  }

  if (ts.isBinaryExpression(expr)) {
    const opStr = binaryOpFromSyntaxKind(expr.operatorToken.kind);
    if (!opStr) return null;
    const left = exprToIr(expr.left, paramNames, freeVars);
    const right = exprToIr(expr.right, paramNames, freeVars);
    if (!left || !right) return null;
    if (opStr === "in") return { kind: "in", left, right };
    return { kind: "binary", op: opStr, left, right };
  }

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = exprToIr(expr.operand, paramNames, freeVars);
    if (!operand) return null;
    return { kind: "unary", op: "!", operand };
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const resolved = resolveMemberPath(expr, paramNames);
    if (resolved) return { kind: "member", param: resolved.param, path: resolved.path };
    return null;
  }

  if (ts.isIdentifier(expr)) {
    if (paramNames.includes(expr.text)) return { kind: "member", param: expr.text, path: [] };
    freeVars.add(expr.text);
    return { kind: "param", key: expr.text };
  }

  if (
    ts.isStringLiteral(expr) ||
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    let value: unknown;
    if (ts.isStringLiteral(expr)) value = expr.text;
    else if (ts.isNumericLiteral(expr)) value = Number(expr.text);
    else if (expr.kind === ts.SyntaxKind.TrueKeyword) value = true;
    else if (expr.kind === ts.SyntaxKind.FalseKeyword) value = false;
    else value = null;
    return { kind: "const", value };
  }

  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if ((method === "some" || method === "every") && expr.arguments.length === 1 && ts.isPropertyAccessExpression(callee.expression)) {
        const receiverResolved = resolveMemberPath(callee.expression, paramNames);
        if (receiverResolved && receiverResolved.path.length >= 1) {
          const innerFn = expr.arguments[0];
          if (ts.isArrowFunction(innerFn) || ts.isFunctionExpression(innerFn)) {
            const innerParamNames = innerFn.parameters
              .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : "e"))
              .slice(0, 1);
            const innerParam = innerParamNames[0] ?? "e";
            const innerFreeVars = new Set<string>();
            let innerExpr: ts.Expression;
            if (ts.isBlock(innerFn.body)) {
              if (innerFn.body.statements.length !== 1) return null;
              const st = innerFn.body.statements[0];
              if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
              innerExpr = st.expression;
            } else {
              innerExpr = innerFn.body;
            }
            const innerWhere = exprToIr(innerExpr, innerParamNames, innerFreeVars);
            if (!innerWhere) return null;
            return {
              kind: "exists",
              ...(method === "every" ? { negated: true } : {}),
              rootParam: receiverResolved.param,
              relationKey: receiverResolved.path[0],
              innerParam,
              innerWhere,
            };
          }
        }
      }
      if (ALLOWED_METHODS.has(method)) {
        const receiver = exprToIr(callee.expression, paramNames, freeVars);
        const args = expr.arguments.map((a) => exprToIr(a, paramNames, freeVars));
        if (!receiver || args.some((a) => a === null)) return null;
        return { kind: "call", method, receiver, args: args as IrNode[] };
      }
    }
    // count(p.id), sum(p.price), groupConcat(p.name, ", "), count(distinct(p.id)), etc.
    if (ts.isIdentifier(callee)) {
      const rawName = callee.text;
      const funcName = toIrFuncName(rawName);
      if (AGGREGATE_FUNCS.has(funcName)) {
        const argExpr = expr.arguments[0] as ts.Expression | undefined;
        let arg: IrNode | null = null;
        let isDistinct = false;

        if (argExpr) {
          // Detect distinct(field) wrapper: count(distinct(p.id))
          if (ts.isCallExpression(argExpr)) {
            const innerCallee = argExpr.expression;
            if (ts.isIdentifier(innerCallee) && innerCallee.text === "distinct") {
              const inner = argExpr.arguments[0] as ts.Expression | undefined;
              if (inner && ts.isPropertyAccessExpression(inner)) {
                const resolved = resolveMemberPath(inner, paramNames);
                if (resolved) {
                  arg = { kind: "member", param: resolved.param, path: resolved.path };
                  isDistinct = true;
                }
              }
            }
          } else if (ts.isPropertyAccessExpression(argExpr)) {
            const resolved = resolveMemberPath(argExpr, paramNames);
            if (resolved) arg = { kind: "member", param: resolved.param, path: resolved.path };
          }
        }

        let separator: string | undefined;
        if (funcName === "GROUP_CONCAT" || funcName === "STRING_AGG") {
          const sepExpr = expr.arguments[1] as ts.Expression | undefined;
          if (sepExpr && ts.isStringLiteral(sepExpr)) separator = sepExpr.text;
        }

        return {
          kind: "aggregate",
          func: funcName as IrAggregate["func"],
          arg,
          ...(isDistinct ? { distinct: true } : {}),
          ...(separator !== undefined ? { separator } : {}),
        };
      }
    }
    return null;
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const arr: unknown[] = [];
    for (const e of expr.elements) {
      if (e.kind === ts.SyntaxKind.SpreadElement) return null;
      const ir = exprToIr(e, paramNames, freeVars);
      if (!ir || ir.kind !== "const") return null;
      arr.push(ir.value);
    }
    return { kind: "const", value: arr };
  }

  return null;
}

function extractParamNames(fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
  return fn.parameters.map(p =>
    p.name && ts.isIdentifier(p.name) ? p.name.text : "u"
  );
}

function arrowToIr(
  fn: ts.ArrowFunction | ts.FunctionExpression
): { ir: IrNode; freeVars: string[] } | null {
  const paramNames = extractParamNames(fn);
  const freeVars = new Set<string>();

  let expr: ts.Expression;
  if (ts.isBlock(fn.body)) {
    if (fn.body.statements.length !== 1) return null;
    const st = fn.body.statements[0];
    if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
    expr = st.expression;
  } else {
    expr = fn.body;
  }

  const ir = exprToIr(expr, paramNames, freeVars);
  if (!ir) return null;
  return { ir, freeVars: [...freeVars] };
}

function transformArrowCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  methodName: string
): ts.CallExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (expr.name.text !== methodName) return null;
  if (!isTyphexType(expr.expression, checker)) return null;

  const args = [...call.arguments];
  if (args.length === 0) return null;
  const first = args[0];
  if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;

  const result = arrowToIr(first);
  if (!result) return null;

  const { ir, freeVars } = result;
  const paramsLiteral = freeVars.length > 0
    ? ts.factory.createObjectLiteralExpression(
        freeVars.map(v => ts.factory.createShorthandPropertyAssignment(ts.factory.createIdentifier(v)))
      )
    : ts.factory.createObjectLiteralExpression([]);

  return ts.factory.updateCallExpression(
    call, call.expression, call.typeArguments,
    [irNodeToTsLiteral(ir), paramsLiteral]
  );
}

export function transformWhereCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  return transformArrowCall(call, checker, "where");
}

export function transformHavingCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  return transformArrowCall(call, checker, "having");
}
