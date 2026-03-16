/**
 * Transformer for .select() calls: converts object literal arrows to IrSelect.
 */

import * as ts from "typescript";
import type { IrSelect, IrAggregate, IrNode } from "../ir/types.js";
import {
  isTyphexType,
  memberPath,
  unwrapObjectLiteral,
  irSelectToTsLiteral,
  irAggregateToTsLiteral,
} from "./shared.js";

const DEFAULT_ROW_PARAM = "u";

const AGGREGATE_FUNCS = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT", "GROUP_CONCAT", "STRING_AGG", "ARRAY_AGG", "JSON_AGG"]);

/** Map JS stub function names to IR func names. */
function toIrFuncName(rawName: string): string {
  const lower = rawName.toLowerCase();
  if (lower === "groupconcat") return "GROUP_CONCAT";
  if (lower === "stringagg")   return "STRING_AGG";
  if (lower === "arrayagg")    return "ARRAY_AGG";
  if (lower === "jsonagg")     return "JSON_AGG";
  return rawName.toUpperCase();
}

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

/** Try to parse a CallExpression as an aggregate function call. */
function tryParseAggregate(call: ts.CallExpression, paramName: string): IrAggregate | null {
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) return null;
  const rawName = callee.text;
  const funcName = toIrFuncName(rawName);
  if (!AGGREGATE_FUNCS.has(funcName)) return null;

  const argExpr = call.arguments[0] as ts.Expression | undefined;
  let arg: IrNode | null = null;
  let isDistinct = false;

  if (argExpr) {
    // Detect distinct(field) wrapper: count(distinct(p.id))
    if (ts.isCallExpression(argExpr)) {
      const innerCallee = argExpr.expression;
      if (ts.isIdentifier(innerCallee) && innerCallee.text === "distinct") {
        const inner = argExpr.arguments[0] as ts.Expression | undefined;
        if (inner && ts.isPropertyAccessExpression(inner)) {
          const path = memberPath(inner, paramName);
          if (path && path.length > 0) {
            arg = { kind: "member", param: paramName, path };
            isDistinct = true;
          }
        }
      }
    } else if (ts.isPropertyAccessExpression(argExpr)) {
      const path = memberPath(argExpr, paramName);
      if (path && path.length > 0) arg = { kind: "member", param: paramName, path };
    }
  }

  // Extract separator for groupConcat(field, ", ") and stringAgg(field, sep)
  let separator: string | undefined;
  if (funcName === "GROUP_CONCAT" || funcName === "STRING_AGG") {
    const sepExpr = call.arguments[1] as ts.Expression | undefined;
    if (sepExpr && ts.isStringLiteral(sepExpr)) separator = sepExpr.text;
  }

  const alias = rawName.toLowerCase();
  return {
    kind: "aggregate",
    func: funcName as IrAggregate["func"],
    arg,
    alias,
    ...(isDistinct ? { distinct: true } : {}),
    ...(separator !== undefined ? { separator } : {}),
  };
}

function arrowToIrSelect(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  { paramName, bindings, restName }: ParamBindings
): IrSelect | null {
  // Handle single-expression body shorthands (non-block, non-object forms)
  if (!ts.isBlock(fn.body)) {
    const body = fn.body;

    // p => p  →  select *
    if (ts.isIdentifier(body) && body.text === paramName) {
      return { param: paramName, paths: [], aliases: [], rest: true };
    }

    // p => p.id  or  p => p.author.name  →  single column
    if (ts.isPropertyAccessExpression(body)) {
      const path = memberPath(body, paramName);
      if (path && path.length > 0) {
        const alias = path[path.length - 1];
        return { param: paramName, paths: [path], aliases: [alias] };
      }
    }

    // p => count(p.id)  →  single aggregate
    if (ts.isCallExpression(body)) {
      const agg = tryParseAggregate(body, paramName);
      if (agg) return { param: paramName, paths: [], aliases: [], aggregates: [agg] };
    }
  }

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
  const aggregates: IrAggregate[] = [];
  let rest = false;

  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (restName && ts.isIdentifier(prop.expression) && prop.expression.text === restName) {
        rest = true;
        continue;
      }
      if (ts.isIdentifier(prop.expression) && prop.expression.text === paramName) {
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

    // { total: count(p.id) }, { max: max(p.salary) }, etc.
    if (ts.isCallExpression(value)) {
      const agg = tryParseAggregate(value, paramName);
      if (agg) { aggregates.push({ ...agg, alias: name }); continue; }
    }

    return null;
  }

  if (paths.length === 0 && aggregates.length === 0 && !rest) return null;
  return {
    param: paramName,
    paths,
    aliases,
    ...(rest ? { rest: true } : {}),
    ...(aggregates.length > 0 ? { aggregates } : {}),
  };
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

export { irAggregateToTsLiteral };
