/**
 * Runtime parsing for `.update(e => ({ col: e.field, ... }))` arrows into
 * a map of column names to IR nodes (member paths or literals).
 */

import type { IrNode } from "../ir/types.js";
import { DEFAULT_ROW_PARAM } from "../arrow/constants.js";
import { extractArrowBody, inferParamNames, parseExpressionSource } from "./arrow-source.js";
import {
  isLiteral,
  isMemberExpression,
  isObjectExpression,
  isProperty,
  objectPropertyValue,
  propertyKeyName,
} from "./acorn-helpers.js";
import { resolveMemberPath } from "./acorn-member.js";

export function parseArrowToUpdateSet(
  fn: (...args: unknown[]) => Record<string, unknown>,
): Record<string, IrNode> {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) throw new Error("update lambda must be an arrow function");

  const paramNames = inferParamNames(src);
  const paramName = paramNames[0] ?? DEFAULT_ROW_PARAM;
  const expr = parseExpressionSource(body.startsWith("(") ? body : `(${body})`);
  if (!isObjectExpression(expr)) {
    throw new Error("update lambda must return an object literal");
  }

  const result: Record<string, IrNode> = {};
  for (const raw of expr.properties) {
    if (!isProperty(raw) || raw.computed) {
      throw new Error("update object keys must be identifiers");
    }

    const keyName = propertyKeyName(raw.key);
    if (!keyName) throw new Error("update object keys must be identifiers");

    const value = objectPropertyValue(raw.value);
    if (!value) {
      throw new Error(`update "${keyName}": value must be a column reference or literal`);
    }
    if (isMemberExpression(value)) {
      const resolved = resolveMemberPath(value, paramNames);
      if (!resolved || resolved.path.length === 0) {
        throw new Error(
          `update "${keyName}": expected ${paramName}.<column> or <ctes>.<cte>.<column>`,
        );
      }
      result[keyName] = { kind: "member", param: resolved.param, path: resolved.path };
      continue;
    }
    if (isLiteral(value)) {
      result[keyName] = { kind: "const", value: value.value };
      continue;
    }
    throw new Error(`update "${keyName}": value must be a column reference or literal`);
  }

  if (Object.keys(result).length === 0) {
    throw new Error("update lambda must set at least one column");
  }
  return result;
}
