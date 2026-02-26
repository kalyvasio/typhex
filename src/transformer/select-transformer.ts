/**
 * Transformer for .select() calls: converts object literal arrows to IrSelect.
 */

import * as ts from "typescript";
import type { IrSelect } from "../ir/types.js";
import {
  isTyphexType,
  memberPath,
  unwrapObjectLiteral,
  irSelectToTsLiteral,
} from "./shared.js";

const DEFAULT_ROW_PARAM = "u";

interface ParamBindings {
  paramName: string;
  bindings: Map<string, string[]> | null;
  restName: string | null;
}

/**
 * From the arrow's first parameter, derive:
 * - paramName for member access resolution (e.g. "u")
 * - bindings map for destructured patterns ({ id, name })
 * - restName for rest binding ({ id, ...rest })
 */
function getParamBindings(param: ts.BindingName | undefined): ParamBindings {
  if (!param) return { paramName: DEFAULT_ROW_PARAM, bindings: null, restName: null };
  if (ts.isIdentifier(param)) return { paramName: param.text, bindings: null, restName: null };
  if (!ts.isObjectBindingPattern(param)) return { paramName: DEFAULT_ROW_PARAM, bindings: null, restName: null };

  const bindings = new Map<string, string[]>();
  let restName: string | null = null;

  for (const el of param.elements) {
    if (el.dotDotDotToken) {
      if (ts.isIdentifier(el.name)) restName = el.name.text;
      continue;
    }
    const boundName = ts.isIdentifier(el.name) ? el.name.text : null;
    if (!boundName) continue;
    const pathSegment =
      el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : boundName;
    bindings.set(boundName, [pathSegment]);
  }

  if (bindings.size === 0 && !restName) {
    return { paramName: DEFAULT_ROW_PARAM, bindings: null, restName: null };
  }
  return { paramName: DEFAULT_ROW_PARAM, bindings: bindings.size > 0 ? bindings : null, restName };
}

function arrowToIrSelect(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  { paramName, bindings, restName }: ParamBindings
): IrSelect | null {
  let obj: ts.ObjectLiteralExpression | null;
  if (ts.isBlock(fn.body)) {
    if (fn.body.statements.length !== 1) return null;
    const st = fn.body.statements[0];
    if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
    obj = unwrapObjectLiteral(st.expression);
  } else {
    obj = unwrapObjectLiteral(fn.body);
  }
  if (!obj) return null;

  const paths: string[][] = [];
  const aliases: string[] = [];
  let rest = false;

  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (restName && ts.isIdentifier(prop.expression) && prop.expression.text === restName) {
        rest = true;
        continue;
      }
      return null;
    }

    const name =
      prop.name && ts.isIdentifier(prop.name) ? prop.name.text
      : prop.name && ts.isComputedPropertyName(prop.name) ? null
      : null;
    if (!name) return null;

    if (ts.isShorthandPropertyAssignment(prop)) {
      const path = bindings?.get(name);
      if (path) { paths.push(path); aliases.push(name); continue; }
      return null;
    }

    if (!ts.isPropertyAssignment(prop)) return null;
    const value = prop.initializer;

    if (ts.isPropertyAccessExpression(value)) {
      const path = memberPath(value, paramName);
      if (!path || path.length === 0) return null;
      paths.push(path);
      aliases.push(name);
      continue;
    }

    if (bindings && ts.isIdentifier(value)) {
      const path = bindings.get(value.text);
      if (path) { paths.push(path); aliases.push(name); continue; }
    }

    return null;
  }

  if (paths.length === 0 && !rest) return null;
  return { param: paramName, paths, aliases, ...(rest ? { rest: true } : {}) };
}

export function transformSelectCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (expr.name.text !== "select") return null;
  if (!isTyphexType(expr.expression, checker)) return null;

  const args = [...call.arguments];
  if (args.length === 0) return null;
  const first = args[0];
  if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;

  const pb = getParamBindings(first.parameters[0]?.name);
  const irSelect = arrowToIrSelect(first, pb);
  if (!irSelect) return null;

  return ts.factory.updateCallExpression(
    call, call.expression, call.typeArguments,
    [irSelectToTsLiteral(irSelect)]
  );
}
