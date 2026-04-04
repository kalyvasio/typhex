import * as ts from "typescript";
import { isTyphexType, memberPath, unwrapObjectLiteral } from "./shared.js";

const JOIN_METHOD_NAMES = new Set(["innerJoin", "leftJoin", "rightJoin", "crossJoin", "fullJoin"]);

export function transformJoinCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (!JOIN_METHOD_NAMES.has(expr.name.text)) return null;
  if (!isTyphexType(expr.expression, checker)) return null;

  const args = [...call.arguments];
  if (args.length !== 1) return null;
  const first = args[0];
  if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;

  const param = first.parameters[0]?.name;
  if (!param || !ts.isIdentifier(param)) return null;
  const paramName = param.text;

  const body = first.body;
  const keys: string[] = [];

  // Form 1: p => ({ author: p.author }) — object literal body
  const objLit = unwrapObjectLiteral(ts.isParenthesizedExpression(body) ? body.expression : body as ts.Expression);
  if (objLit) {
    for (const prop of objLit.properties) {
      if (!ts.isPropertyAssignment(prop)) return null;
      const keyName = ts.isIdentifier(prop.name) ? prop.name.text
        : ts.isStringLiteral(prop.name) ? prop.name.text
        : null;
      if (!keyName) return null;
      keys.push(keyName);
    }
  } else if (ts.isPropertyAccessExpression(body)) {
    // Form 2: p => p.author — single member access
    const path = memberPath(body, paramName);
    if (!path || path.length === 0) return null;
    keys.push(path[0]);
  } else {
    return null;
  }

  if (keys.length === 0) return null;

  const f = ts.factory;
  const keysLiteral = f.createArrayLiteralExpression(
    keys.map(k => f.createStringLiteral(k))
  );
  return f.updateCallExpression(call, call.expression, call.typeArguments, [keysLiteral]);
}
