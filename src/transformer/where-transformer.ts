/**
 * Transformer for .where() calls: converts arrow predicates to IR.
 */

import * as ts from "typescript";
import type { IrNode } from "../ir/types.js";
import { isTyphexType, memberPath } from "./shared.js";

function binaryOpToString(
  kind: ts.SyntaxKind
): IrNode extends { op: infer O } ? O : never | "in" | null {
  const m: Record<number, string> = {
    [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
    [ts.SyntaxKind.BarBarToken]: "||",
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
    [ts.SyntaxKind.EqualsEqualsToken]: "==",
    [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
    [ts.SyntaxKind.GreaterThanToken]: ">",
    [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
    [ts.SyntaxKind.LessThanToken]: "<",
    [ts.SyntaxKind.LessThanEqualsToken]: "<=",
    [ts.SyntaxKind.InKeyword]: "in",
  };
  return (m[kind] as IrNode extends { op: infer O } ? O : never | "in" | null) ?? null;
}

function exprToIr(
  expr: ts.Expression,
  param: ts.BindingName | undefined,
  paramName: string,
  freeVars: Set<string>
): IrNode | null {
  if (ts.isParenthesizedExpression(expr)) {
    return exprToIr(expr.expression, param, paramName, freeVars);
  }

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const opStr = binaryOpToString(op);
    if (opStr === "in") {
      const left = exprToIr(expr.left, param, paramName, freeVars);
      const right = exprToIr(expr.right, param, paramName, freeVars);
      if (!left || !right) return null;
      return { kind: "in", left, right };
    }
    if (opStr) {
      const left = exprToIr(expr.left, param, paramName, freeVars);
      const right = exprToIr(expr.right, param, paramName, freeVars);
      if (!left || !right) return null;
      return { kind: "binary", op: opStr, left, right };
    }
  }

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = exprToIr(expr.operand, param, paramName, freeVars);
    if (!operand) return null;
    return { kind: "unary", op: "!", operand };
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const path = memberPath(expr, paramName);
    if (path) return { kind: "member", param: paramName, path };
  }

  if (ts.isIdentifier(expr)) {
    if (expr.text === paramName) return { kind: "member", param: paramName, path: [] };
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
      if (["startsWith", "endsWith", "includes"].includes(method)) {
        const receiver = exprToIr(callee.expression, param, paramName, freeVars);
        const args = expr.arguments.map(a =>
          exprToIr(a as ts.Expression, param, paramName, freeVars)
        );
        if (!receiver || args.some(a => a === null)) return null;
        return { kind: "call", method, receiver, args: args as IrNode[] };
      }
    }
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const arr: unknown[] = [];
    for (const e of expr.elements) {
      if (e.kind === ts.SyntaxKind.SpreadElement) return null;
      const ir = exprToIr(e as ts.Expression, param, paramName, freeVars);
      if (!ir || ir.kind !== "const") return null;
      arr.push(ir.value);
    }
    return { kind: "const", value: arr };
  }

  return null;
}

function arrowToIr(
  fn: ts.ArrowFunction | ts.FunctionExpression
): { ir: IrNode; freeVars: string[] } | null {
  const param = fn.parameters[0]?.name;
  const paramName = param && ts.isIdentifier(param) ? param.text : "u";
  const freeVars = new Set<string>();
  const body = fn.body;
  let expr: ts.Expression;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return null;
    const st = body.statements[0];
    if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
    expr = st.expression;
  } else {
    expr = body;
  }
  const ir = exprToIr(expr, param, paramName, freeVars);
  if (!ir) return null;
  return { ir, freeVars: [...freeVars] };
}

function irToObjectLiteral(ir: IrNode): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [];
  props.push(f.createPropertyAssignment("kind", f.createStringLiteral(ir.kind)));
  switch (ir.kind) {
    case "binary":
      props.push(f.createPropertyAssignment("op", f.createStringLiteral(ir.op)));
      props.push(f.createPropertyAssignment("left", irToObjectLiteral(ir.left)));
      props.push(f.createPropertyAssignment("right", irToObjectLiteral(ir.right)));
      break;
    case "unary":
      props.push(f.createPropertyAssignment("op", f.createStringLiteral(ir.op)));
      props.push(f.createPropertyAssignment("operand", irToObjectLiteral(ir.operand)));
      break;
    case "member":
      props.push(f.createPropertyAssignment("param", f.createStringLiteral(ir.param)));
      props.push(
        f.createPropertyAssignment(
          "path",
          f.createArrayLiteralExpression(ir.path.map(p => f.createStringLiteral(p)))
        )
      );
      break;
    case "const":
      props.push(f.createPropertyAssignment("value", valueToExpression(ir.value, f)));
      break;
    case "param":
      props.push(f.createPropertyAssignment("key", f.createStringLiteral(ir.key)));
      break;
    case "in":
      props.push(f.createPropertyAssignment("left", irToObjectLiteral(ir.left)));
      props.push(f.createPropertyAssignment("right", irToObjectLiteral(ir.right)));
      break;
    case "call":
      props.push(f.createPropertyAssignment("method", f.createStringLiteral(ir.method)));
      props.push(f.createPropertyAssignment("receiver", irToObjectLiteral(ir.receiver)));
      props.push(
        f.createPropertyAssignment(
          "args",
          f.createArrayLiteralExpression(ir.args.map(a => irToObjectLiteral(a)))
        )
      );
      break;
  }
  return f.createObjectLiteralExpression(props);
}

function valueToExpression(value: unknown, f: ts.NodeFactory): ts.Expression {
  if (value === null) return f.createNull();
  switch (typeof value) {
    case "string":
      return f.createStringLiteral(value);
    case "number":
      return f.createNumericLiteral(value);
    case "boolean":
      return value ? f.createTrue() : f.createFalse();
    default:
      if (Array.isArray(value)) {
        return f.createArrayLiteralExpression(
            (value as unknown[]).map(v =>
                typeof v === "string"
                    ? f.createStringLiteral(v)
                    : typeof v === "number"
                        ? f.createNumericLiteral(v)
                        : f.createNull()
            )
        );
      }
      return f.createStringLiteral(String(value));
  }
}

// Transformer functions

export function transformWhereCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (expr.name.text !== "where") return null;
  
  // Check if the receiver is a Typhex Table or QueryBuilder
  const receiver = expr.expression;
  if (!isTyphexType(receiver, checker)) {
    return null; // Not a Typhex type, skip transformation
  }
  
  const args = [...call.arguments];
  if (args.length === 0) return null;
  const first = args[0];
  if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;

  const result = arrowToIr(first);
  if (!result) return null;

  const { ir, freeVars } = result;
  const irLiteral = irToObjectLiteral(ir);
  const paramsLiteral =
    freeVars.length > 0
      ? ts.factory.createObjectLiteralExpression(
          freeVars.map((varName) =>
            ts.factory.createShorthandPropertyAssignment(ts.factory.createIdentifier(varName))
          )
        )
      : ts.factory.createObjectLiteralExpression([]);

  return ts.factory.updateCallExpression(
    call,
    call.expression,
    call.typeArguments,
    [irLiteral, paramsLiteral]
  );
}
