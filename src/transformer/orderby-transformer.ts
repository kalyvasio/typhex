import * as ts from "typescript";
import { isTyphexType, memberPath, irOrderByToTsLiteral } from "./shared.js";

export function transformOrderByCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (expr.name.text !== "orderBy") return null;
  if (!isTyphexType(expr.expression, checker)) return null;

  const args = [...call.arguments];
  if (args.length === 0) return null;
  const first = args[0];
  if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;

  const param = first.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return null;
  const paramName = param.text;

  const body = first.body;
  if (!ts.isPropertyAccessExpression(body) && !ts.isIdentifier(body)) return null;

  const path = ts.isPropertyAccessExpression(body)
    ? memberPath(body, paramName)
    : null;

  if (!path || path.length === 0) return null;

  // Only transform when direction is absent or a known string literal; otherwise
  // leave the call for runtime parsing to preserve the original semantics.
  if (args.length >= 2) {
    if (!ts.isStringLiteral(args[1])) return null;
    const d = args[1].text;
    if (d !== "asc" && d !== "desc") return null;
  }
  let direction: "asc" | "desc" = "asc";
  if (args.length >= 2 && ts.isStringLiteral(args[1])) {
    if (args[1].text === "desc") direction = "desc";
  }

  const ir = irOrderByToTsLiteral({ param: paramName, path, direction });
  return ts.factory.updateCallExpression(
    call, call.expression, call.typeArguments,
    [ir]
  );
}
