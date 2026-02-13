/**
 * TypeScript transformer: rewrites .where(arrow) to .where(ir, params).
 * Use with ttypescript or ts-patch.
 */

import * as ts from "typescript";
import type { IrNode } from "../ir/types.js";

// Type checking helpers

function checkSymbolIsTyphex(symbol: ts.Symbol): boolean {
  const symbolName = symbol.getName();
  
  // Only check Table and QueryBuilder symbols
  if (symbolName !== "Table" && symbolName !== "QueryBuilder") {
    return false;
  }
  
  // Check declarations to verify source file
  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) {
    return false;
  }
  
  // Verify all declarations are from typhex package
  for (const decl of declarations) {
    const sourceFile = decl.getSourceFile();
    const fileName = sourceFile.fileName;
    
    // Normalize path separators
    const normalizedPath = fileName.replace(/\\/g, "/");
    
    // Check if file is from our package structure
    const isTyphexFile = 
      (normalizedPath.includes("/typhex/") || normalizedPath.includes("/typhex\\")) &&
      (normalizedPath.includes("/orm/table") || normalizedPath.includes("/orm/query-builder")) &&
      (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".js") || normalizedPath.endsWith(".d.ts"));
    
    if (!isTyphexFile) {
      return false; // At least one declaration is not from typhex
    }
  }
  
  return true; // All declarations are from typhex
}

function isTyphexType(
  receiver: ts.Expression,
  checker: ts.TypeChecker
): boolean {
  try {
    const receiverType = checker.getTypeAtLocation(receiver);
    
    // Get the type's symbol - for generic types like Table<T>, this gets the base class
    let typeSymbol = receiverType.getSymbol();
    
    // For generic instantiations, try to get symbol from constructor
    if (!typeSymbol) {
      const props = receiverType.getProperties();
      const constructorProp = props.find(p => p.getName() === "constructor");
      if (constructorProp) {
        const constructorType = checker.getTypeOfSymbolAtLocation(constructorProp, receiver);
        const constructorSig = constructorType.getCallSignatures();
        if (constructorSig.length > 0) {
          const returnType = constructorSig[0].getReturnType();
          typeSymbol = returnType.getSymbol();
        }
      }
    }
    
    // Also check alias symbol for type aliases
    if (!typeSymbol && receiverType.aliasSymbol) {
      typeSymbol = receiverType.aliasSymbol;
    }
    
    if (!typeSymbol) {
      return false;
    }
    
    return checkSymbolIsTyphex(typeSymbol);
  } catch {
    // If type checking fails, be conservative and skip transformation
    return false;
  }
}

// IR conversion helpers

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

function memberPath(
  expr: ts.PropertyAccessExpression,
  paramName: string
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

function exprToIr(
  expr: ts.Expression,
  param: ts.BindingName | undefined,
  paramName: string,
  freeVars: Set<string>
): IrNode | null {
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
                        (ir.value as unknown[]).map(v =>
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

// Transformer functions

function tryRewriteWhereCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  const name = expr.name.text;
  if (name !== "where" && name !== "select" && name !== "orderBy") return null;
  
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
          freeVars.map(varName =>
            ts.factory.createShorthandPropertyAssignment(ts.factory.createIdentifier(varName))
          )
        )
      : ts.factory.createObjectLiteralExpression([]);
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

function visit(
  node: ts.Node,
  ctx: ts.TransformationContext,
  checker: ts.TypeChecker
): ts.Node {
  if (ts.isCallExpression(node)) {
    const rewritten = tryRewriteWhereCall(node, checker);
    if (rewritten) return rewritten;
  }
  return ts.visitEachChild(node, n => visit(n, ctx, checker), ctx);
}

function visitSourceFile(
  node: ts.SourceFile,
  ctx: ts.TransformationContext,
  checker: ts.TypeChecker
): ts.SourceFile {
  return ts.visitEachChild(node, n => visit(n, ctx, checker), ctx) as ts.SourceFile;
}

// Main transformer factory

export function createWhereTransformer(program: ts.Program) {
  const checker = program.getTypeChecker();
  
  return (ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sf: ts.SourceFile) => visitSourceFile(sf, ctx, checker);
  };
}
