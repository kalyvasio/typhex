/**
 * Arrow parameter binding extraction for the compile-time transformer:
 * simple identifiers, object destructuring, and scope frames for correlated
 * subqueries in nested lambdas.
 */

import ts from "typescript";
import { DEFAULT_ROW_PARAM } from "../arrow/constants.js";

export interface ParamBindings {
  paramName: string;
  bindings: Map<string, string[]> | null;
  restName: string | null;
}

const NO_BINDINGS: ParamBindings = {
  paramName: DEFAULT_ROW_PARAM,
  bindings: null,
  restName: null,
};

export function getParamBindings(param: ts.BindingName | undefined): ParamBindings {
  if (!param) return NO_BINDINGS;
  if (ts.isIdentifier(param)) {
    return { paramName: param.text, bindings: null, restName: null };
  }
  if (!ts.isObjectBindingPattern(param)) return NO_BINDINGS;

  const bindings = new Map<string, string[]>();
  let restName: string | null = null;
  for (const el of param.elements) {
    if (el.dotDotDotToken) {
      if (ts.isIdentifier(el.name)) restName = el.name.text;
      continue;
    }
    if (!ts.isIdentifier(el.name)) continue;
    const localName = el.name.text;
    const sourceKey =
      el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : localName;
    bindings.set(localName, [sourceKey]);
  }

  if (bindings.size === 0 && !restName) return NO_BINDINGS;
  return {
    paramName: DEFAULT_ROW_PARAM,
    bindings: bindings.size > 0 ? bindings : null,
    restName,
  };
}

export interface ScopeFrame {
  paramName: string;
  bindings?: Map<string, string[]>;
}

export function frameFromBindingName(name: ts.BindingName | undefined): ScopeFrame | null {
  const pb = getParamBindings(name);
  if (pb === NO_BINDINGS) return null;
  const frame: ScopeFrame = { paramName: pb.paramName };
  if (pb.bindings) frame.bindings = pb.bindings;
  return frame;
}
