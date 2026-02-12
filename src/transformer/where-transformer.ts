/**
 * TypeScript transformer: rewrites .where(arrow) to .where(ir, params).
 * Use with ttypescript or ts-patch.
 */

import type * as ts from "typescript";
import type { IrNode } from "../ir/types.js";

export function createWhereTransformer(ts: typeof import("typescript")) {
  return (ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sf: ts.SourceFile) => visitSourceFile(sf, ctx, ts);
  };

  function visitSourceFile(
    node: ts.SourceFile,
    ctx: ts.TransformationContext,
    ts: typeof import("typescript")
  ): ts.SourceFile {
    return ts.visitEachChild(node, (n) => visit(n, ctx, ts), ctx) as ts.SourceFile;
  }

  function visit(
    node: ts.Node,
    ctx: ts.TransformationContext,
    ts: typeof import("typescript")
  ): ts.Node {
    if (ts.isCallExpression(node)) {
      const rewritten = tryRewriteWhereCall(node, ts);
      if (rewritten) return rewritten;
    }
    return ts.visitEachChild(node, (n) => visit(n, ctx, ts), ctx);
  }

  function tryRewriteWhereCall(
    call: ts.CallExpression,
    ts: typeof import("typescript")
  ): ts.CallExpression | null {
    const expr = call.expression;
    if (!ts.isPropertyAccessExpression(expr)) return null;
    const name = expr.name.text;
    if (name !== "where" && name !== "select" && name !== "orderBy") return null;
    const args = [...call.arguments];
    if (args.length === 0) return null;
    const first = args[0];
    if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;

    const ir = arrowToIr(first, ts);
    if (!ir) return null;

    const irLiteral = irToObjectLiteral(ir, ts);
    const paramsLiteral = ts.factory.createObjectLiteralExpression([]);
    const newArgs =
      name === "where" || name === "select"
        ? [irLiteral, paramsLiteral]
        : name === "orderBy"
          ? [irLiteral]
          : args;
    return ts.factory.updateCallExpression(
      call,
      call.expression,
      call.typeArguments,
      newArgs
    );
  }

  function arrowToIr(
    fn: ts.ArrowFunction | ts.FunctionExpression,
    ts: typeof import("typescript")
  ): IrNode | null {
    const body = fn.body;
    if (ts.isBlock(body)) {
      if (body.statements.length !== 1) return null;
      const st = body.statements[0];
      if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
      return exprToIr(st.expression, fn.parameters[0]?.name, ts);
    }
    return exprToIr(body, fn.parameters[0]?.name, ts);
  }

  function exprToIr(
    expr: ts.Expression,
    param: ts.BindingName | undefined,
    ts: typeof import("typescript")
  ): IrNode | null {
    const paramName =
      param && ts.isIdentifier(param) ? param.text : "u";

    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      const opStr = binaryOpToString(op, ts);
      if (opStr === "in") {
        const left = exprToIr(expr.left, param, ts);
        const right = exprToIr(expr.right, param, ts);
        if (!left || !right) return null;
        return { kind: "in", left, right };
      }
      if (opStr) {
        const left = exprToIr(expr.left, param, ts);
        const right = exprToIr(expr.right, param, ts);
        if (!left || !right) return null;
        return { kind: "binary", op: opStr, left, right };
      }
    }

    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = exprToIr(expr.operand, param, ts);
      if (!operand) return null;
      return { kind: "unary", op: "!", operand };
    }

    if (ts.isPropertyAccessExpression(expr)) {
      const path = memberPath(expr, paramName, ts);
      if (path) return { kind: "member", param: paramName, path };
    }

    if (ts.isIdentifier(expr)) {
      if (expr.text === paramName) return { kind: "member", param: paramName, path: [] };
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
          const receiver = exprToIr(callee.expression, param, ts);
          const args = expr.arguments.map((a) => exprToIr(a as ts.Expression, param, ts));
          if (!receiver || args.some((a) => a === null)) return null;
          return { kind: "call", method, receiver, args: args as IrNode[] };
        }
      }
    }

    return null;
  }

  function binaryOpToString(
    kind: ts.SyntaxKind,
    ts: typeof import("typescript")
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

  function memberPath(
    expr: ts.PropertyAccessExpression,
    paramName: string,
    ts: typeof import("typescript")
  ): string[] | null {
    const parts: string[] = [];
    let current: ts.Expression = expr;
    while (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
    }
    if (ts.isIdentifier(current) && current.text === paramName) return parts;
    return null;
  }

  function irToObjectLiteral(ir: IrNode, ts: typeof import("typescript")): ts.ObjectLiteralExpression {
    const f = ts.factory;
    const props: ts.ObjectLiteralElementLike[] = [];
    props.push(f.createPropertyAssignment("kind", f.createStringLiteral(ir.kind)));
    switch (ir.kind) {
      case "binary":
        props.push(f.createPropertyAssignment("op", f.createStringLiteral(ir.op)));
        props.push(f.createPropertyAssignment("left", irToObjectLiteral(ir.left, ts)));
        props.push(f.createPropertyAssignment("right", irToObjectLiteral(ir.right, ts)));
        break;
      case "unary":
        props.push(f.createPropertyAssignment("op", f.createStringLiteral(ir.op)));
        props.push(f.createPropertyAssignment("operand", irToObjectLiteral(ir.operand, ts)));
        break;
      case "member":
        props.push(f.createPropertyAssignment("param", f.createStringLiteral(ir.param)));
        props.push(
          f.createPropertyAssignment(
            "path",
            f.createArrayLiteralExpression(ir.path.map((p) => f.createStringLiteral(p)))
          )
        );
        break;
      case "const":
        props.push(
          f.createPropertyAssignment(
            "value",
            ir.value === null
              ? f.createNull()
              : typeof ir.value === "string"
                ? f.createStringLiteral(ir.value)
                : typeof ir.value === "number"
                  ? f.createNumericLiteral(ir.value)
                  : typeof ir.value === "boolean"
                    ? (ir.value ? f.createTrue() : f.createFalse())
                    : Array.isArray(ir.value)
                      ? f.createArrayLiteralExpression(
                          (ir.value as unknown[]).map((v) =>
                            typeof v === "string"
                              ? f.createStringLiteral(v)
                              : typeof v === "number"
                                ? f.createNumericLiteral(v)
                                : f.createNull()
                          )
                        )
                      : f.createStringLiteral(String(ir.value))
          )
        );
        break;
      case "param":
        props.push(f.createPropertyAssignment("key", f.createStringLiteral(ir.key)));
        break;
      case "in":
        props.push(f.createPropertyAssignment("left", irToObjectLiteral(ir.left, ts)));
        props.push(f.createPropertyAssignment("right", irToObjectLiteral(ir.right, ts)));
        break;
      case "call":
        props.push(f.createPropertyAssignment("method", f.createStringLiteral(ir.method)));
        props.push(f.createPropertyAssignment("receiver", irToObjectLiteral(ir.receiver, ts)));
        props.push(
          f.createPropertyAssignment(
            "args",
            f.createArrayLiteralExpression(ir.args.map((a) => irToObjectLiteral(a, ts)))
          )
        );
        break;
    }
    return f.createObjectLiteralExpression(props);
  }
}
