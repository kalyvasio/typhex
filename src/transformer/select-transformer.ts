/**
 * Transformer for .select() calls: converts object literal arrows to IrSelect.
 */

import * as ts from "typescript";
import type { IrSelect } from "../ir/types.js";
import { isTyphexType, memberPath, unwrapObjectLiteral } from "./shared.js";

const DEFAULT_ROW_PARAM = "u";

/**
 * From the arrow's first parameter, get the logical row param name, optional bindings, and optional rest binding name.
 * - Single identifier (u) => paramName "u", bindings null, restName null.
 * - Object pattern ({id, name}) or ({id: userId}) => bindings map; ({ id, ...rest }) => restName "rest".
 */
function getParamNameAndBindings(
  param: ts.BindingName | undefined
): {
  paramName: string;
  bindings: Map<string, string[]> | null;
  restName: string | null;
} {
  if (!param) {
    return { paramName: DEFAULT_ROW_PARAM, bindings: null, restName: null };
  }
  if (ts.isIdentifier(param)) {
    return { paramName: param.text, bindings: null, restName: null };
  }
  if (!ts.isObjectBindingPattern(param)) {
    return { paramName: DEFAULT_ROW_PARAM, bindings: null, restName: null };
  }
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
      el.propertyName && ts.isIdentifier(el.propertyName)
        ? el.propertyName.text
        : boundName;
    bindings.set(boundName, [pathSegment]);
  }
  if (bindings.size === 0 && !restName) return { paramName: DEFAULT_ROW_PARAM, bindings: null, restName: null };
  return { paramName: DEFAULT_ROW_PARAM, bindings: bindings.size > 0 ? bindings : null, restName };
}

/** Parse arrow that returns an object literal into IrSelect. Supports (u) => ({ id: u.id }), ({id, name}) => ({ id, name }), and ({ id, ...rest }) => ({ id, ...rest }). */
function arrowToIrSelect(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  paramName: string,
  bindings: Map<string, string[]> | null,
  restBindingName: string | null
): IrSelect | null {
  const body = fn.body;
  let obj: ts.ObjectLiteralExpression | null;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return null;
    const st = body.statements[0];
    if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
    obj = unwrapObjectLiteral(st.expression);
  } else {
    obj = unwrapObjectLiteral(body);
  }
  if (!obj) return null;
  const paths: string[][] = [];
  const aliases: string[] = [];
  let rest = false;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (restBindingName && ts.isIdentifier(prop.expression) && prop.expression.text === restBindingName) {
        rest = true;
        continue;
      }
      return null;
    }
    const name = prop.name
      ? ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isComputedPropertyName(prop.name)
          ? null
          : null
      : null;
    if (!name) return null;

    if (ts.isShorthandPropertyAssignment(prop)) {
      if (bindings) {
        const path = bindings.get(name);
        if (path) {
          paths.push(path);
          aliases.push(name);
          continue;
        }
      }
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
      if (path) {
        paths.push(path);
        aliases.push(name);
        continue;
      }
    }

    return null;
  }
  if (paths.length === 0 && !rest) return null;
  return { param: paramName, paths, aliases, ...(rest ? { rest: true } : {}) };
}

function irSelectToObjectLiteral(sel: IrSelect): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("param", f.createStringLiteral(sel.param)),
    f.createPropertyAssignment(
      "paths",
      f.createArrayLiteralExpression(
        sel.paths.map((path) =>
          f.createArrayLiteralExpression(path.map((p) => f.createStringLiteral(p)))
        )
      )
    ),
  ];
  if (sel.aliases && sel.aliases.length > 0) {
    props.push(
      f.createPropertyAssignment(
        "aliases",
        f.createArrayLiteralExpression(sel.aliases.map((a) => f.createStringLiteral(a)))
      )
    );
  }
  if (sel.rest) {
    props.push(f.createPropertyAssignment("rest", f.createTrue()));
  }
  return f.createObjectLiteralExpression(props);
}

/** Transform .select() call: object literal arrow → IrSelect. */
export function transformSelectCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (expr.name.text !== "select") return null;
  
  // Check if the receiver is a Typhex Table or QueryBuilder
  const receiver = expr.expression;
  if (!isTyphexType(receiver, checker)) {
    return null; // Not a Typhex type, skip transformation
  }
  
  const args = [...call.arguments];
  if (args.length === 0) return null;
  const first = args[0];
  if (!ts.isArrowFunction(first) && !ts.isFunctionExpression(first)) return null;

  const { paramName, bindings, restName } = getParamNameAndBindings(first.parameters[0]?.name);

  const irSelect = arrowToIrSelect(first, paramName, bindings, restName);
  if (!irSelect) return null;
  
  return ts.factory.updateCallExpression(
    call,
    call.expression,
    call.typeArguments,
    [irSelectToObjectLiteral(irSelect)]
  );
}
