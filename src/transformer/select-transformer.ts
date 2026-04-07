/**
 * Transformer for .select() calls: converts object-literal arrows to IrSelect.
 */

import * as ts from "typescript";
import type { IrSelect, IrAggregate } from "../ir/types.js";
import {
  isTyphexType,
  matchTyphexMethodCall,
  memberPath,
  unwrapObjectLiteral,
  parseTsAggregateCall,
  irSelectToTsLiteral,
  irAggregateToTsLiteral,
} from "./shared.js";

const DEFAULT_ROW_PARAM = "u";

// ---------------------------------------------------------------------------
// Parameter binding extraction — identifier or destructured pattern
// ---------------------------------------------------------------------------

interface ParamBindings {
  paramName: string;
  /** For destructured params: maps local name → path segments into the row. */
  bindings: Map<string, string[]> | null;
  /** Name of the ...rest identifier, if any. */
  restName: string | null;
}

const NO_BINDINGS: ParamBindings = {
  paramName: DEFAULT_ROW_PARAM,
  bindings: null,
  restName: null,
};

/**
 * Inspect the arrow's first parameter: if it's a plain identifier, the row is
 * bound to that name; if it's destructured (`{ id, name: n, ...rest }`), build
 * a map from each local binding back to its source key path.
 */
function getParamBindings(param: ts.BindingName | undefined): ParamBindings {
  if (!param) return NO_BINDINGS;
  if (ts.isIdentifier(param)) {
    return { paramName: param.text, bindings: null, restName: null };
  }
  if (!ts.isObjectBindingPattern(param)) return NO_BINDINGS;
  return extractDestructuredBindings(param);
}

/**
 * Walk an object-destructuring pattern and build the local-name → source-key
 * map plus the optional rest identifier. Aliased entries (`{ foo: bar }`)
 * map `bar` back to `["foo"]`.
 */
function extractDestructuredBindings(
  pattern: ts.ObjectBindingPattern
): ParamBindings {
  const bindings = new Map<string, string[]>();
  let restName: string | null = null;

  for (const el of pattern.elements) {
    if (el.dotDotDotToken) {
      if (ts.isIdentifier(el.name)) restName = el.name.text;
      continue;
    }
    if (!ts.isIdentifier(el.name)) continue;

    const localName = el.name.text;
    // `{ foo: bar }` destructuring aliases — propertyName is the source key.
    const sourceKey =
      el.propertyName && ts.isIdentifier(el.propertyName)
        ? el.propertyName.text
        : localName;
    bindings.set(localName, [sourceKey]);
  }

  if (bindings.size === 0 && !restName) return NO_BINDINGS;
  return {
    paramName: DEFAULT_ROW_PARAM,
    bindings: bindings.size > 0 ? bindings : null,
    restName,
  };
}

// ---------------------------------------------------------------------------
// Top-level arrow dispatch
// ---------------------------------------------------------------------------

/**
 * Convert a `.select(arrow)` arrow into an IrSelect. Handles the shorthand
 * bodies (`p => p`, `p => p.col`, `p => count(p.id)`) as well as object-
 * literal bodies. Returns null for shapes that don't map cleanly.
 */
function arrowToIrSelect(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  pb: ParamBindings
): IrSelect | null {
  // Single-expression shorthand bodies: p => p, p => p.id, p => count(p.id)
  if (!ts.isBlock(fn.body)) {
    const shorthand = tryParseShorthandBody(fn.body, pb.paramName);
    if (shorthand) return shorthand;
  }

  const obj = extractReturnedObjectLiteral(fn);
  if (!obj) return null;
  return parseSelectObjectLiteral(obj, pb);
}

/**
 * Return the object literal produced by an arrow body — either directly
 * (expression body) or via a single `return { ... }` statement in a block.
 */
function extractReturnedObjectLiteral(
  fn: ts.ArrowFunction | ts.FunctionExpression
): ts.ObjectLiteralExpression | null {
  if (!ts.isBlock(fn.body)) return unwrapObjectLiteral(fn.body);

  if (fn.body.statements.length !== 1) return null;
  const st = fn.body.statements[0];
  if (!st || !ts.isReturnStatement(st) || !st.expression) return null;
  return unwrapObjectLiteral(st.expression);
}

// ---- Shorthand bodies -------------------------------------------------------

/** Dispatch the single-expression shorthand body shapes to their handlers. */
function tryParseShorthandBody(
  body: ts.ConciseBody,
  paramName: string
): IrSelect | null {
  // p => p  →  SELECT *
  if (ts.isIdentifier(body) && body.text === paramName) {
    return { param: paramName, paths: [], aliases: [], rest: true };
  }

  // p => p.id  or  p => p.author.name  →  single column
  if (ts.isPropertyAccessExpression(body)) {
    return parseShorthandMemberBody(body, paramName);
  }

  // p => count(p.id)  →  single aggregate
  if (ts.isCallExpression(body)) {
    return parseShorthandAggregateBody(body, paramName);
  }

  return null;
}

/** Handle `p => p.id` / `p => p.author.name` — emits a single-column IrSelect aliased to the leaf name. */
function parseShorthandMemberBody(
  body: ts.PropertyAccessExpression,
  paramName: string
): IrSelect | null {
  const path = memberPath(body, paramName);
  if (!path || path.length === 0) return null;
  const alias = path[path.length - 1];
  return { param: paramName, paths: [path], aliases: [alias] };
}

/** Handle `p => count(p.id)` — single aggregate aliased to the lowercased function name. */
function parseShorthandAggregateBody(
  body: ts.CallExpression,
  paramName: string
): IrSelect | null {
  const parsed = parseTsAggregateCall(body, [paramName]);
  if (!parsed) return null;
  const alias = parsed.rawName.toLowerCase();
  return {
    param: paramName,
    paths: [],
    aliases: [],
    aggregates: [{ ...parsed.ir, alias }],
  };
}

// ---- Object literal body ---------------------------------------------------

/**
 * Walk each property of a `{ ... }` select body and accumulate the column
 * paths, aliases, aggregates, and spread flag into an IrSelect. Returns
 * null if any property fails to map.
 */
function parseSelectObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  pb: ParamBindings
): IrSelect | null {
  const paths: string[][] = [];
  const aliases: string[] = [];
  const aggregates: IrAggregate[] = [];
  let rest = false;

  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (!isRestSpread(prop, pb)) return null;
      rest = true;
      continue;
    }

    const keyName = getPropertyKeyName(prop);
    if (!keyName) return null;

    const handled = parseSelectObjectProperty(prop, keyName, pb);
    if (!handled) return null;

    if (handled.kind === "path") {
      paths.push(handled.path);
      aliases.push(keyName);
    } else {
      aggregates.push(handled.aggregate);
    }
  }

  if (paths.length === 0 && aggregates.length === 0 && !rest) return null;
  return {
    param: pb.paramName,
    paths,
    aliases,
    ...(rest ? { rest: true } : {}),
    ...(aggregates.length > 0 ? { aggregates } : {}),
  };
}

/** True if the spread refers to the whole row (or the ...rest binding of a destructured param). */
function isRestSpread(
  prop: ts.SpreadAssignment,
  pb: ParamBindings
): boolean {
  if (!ts.isIdentifier(prop.expression)) return false;
  const name = prop.expression.text;
  return name === pb.restName || name === pb.paramName;
}

/** Return the property's key text — only plain identifier keys are supported. */
function getPropertyKeyName(
  prop: ts.ObjectLiteralElementLike
): string | null {
  const name = prop.name;
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  return null; // computed / literal-string / etc. not supported
}

type PropertyResult =
  | { kind: "path"; path: string[] }
  | { kind: "aggregate"; aggregate: IrAggregate };

/**
 * Classify a single select-object property as either a column path or an
 * aggregate. Handles shorthand (`{ id }`), aliased members (`{ x: p.col }`),
 * destructured locals, and aggregate calls.
 */
function parseSelectObjectProperty(
  prop: ts.ObjectLiteralElementLike,
  keyName: string,
  pb: ParamBindings
): PropertyResult | null {
  // { id }  →  shorthand refers to destructured binding
  if (ts.isShorthandPropertyAssignment(prop)) {
    const path = pb.bindings?.get(keyName);
    return path ? { kind: "path", path } : null;
  }

  if (!ts.isPropertyAssignment(prop)) return null;
  const value = prop.initializer;

  // { col: p.col }  or  { col: p.a.b }
  if (ts.isPropertyAccessExpression(value)) {
    const path = memberPath(value, pb.paramName);
    if (!path || path.length === 0) return null;
    return { kind: "path", path };
  }

  // { col: someDestructuredLocal }
  if (pb.bindings && ts.isIdentifier(value)) {
    const path = pb.bindings.get(value.text);
    if (path) return { kind: "path", path };
  }

  // { total: count(p.id) } / { max: max(p.salary) } / …
  if (ts.isCallExpression(value)) {
    const parsed = parseTsAggregateCall(value, [pb.paramName]);
    if (parsed) return { kind: "aggregate", aggregate: { ...parsed.ir, alias: keyName } };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Rewrite a `.select(arrow)` call on a Typhex Table/QueryBuilder into an IrSelect literal. */
export function transformSelectCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): ts.CallExpression | null {
  const arrow = matchTyphexMethodCall(call, "select", checker, isTyphexType);
  if (!arrow) return null;

  const pb = getParamBindings(arrow.parameters[0]?.name);
  const irSelect = arrowToIrSelect(arrow, pb);
  if (!irSelect) return null;

  return ts.factory.updateCallExpression(
    call, call.expression, call.typeArguments,
    [irSelectToTsLiteral(irSelect)]
  );
}

export { irAggregateToTsLiteral };
