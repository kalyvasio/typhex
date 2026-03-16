/**
 * Shared utilities for Typhex transformers.
 */

import * as ts from "typescript";
import type { IrNode, IrSelect, IrBinary, IrOrderBy, IrAggregate } from "../ir/types.js";

// ---------------------------------------------------------------------------
// Typhex type detection
// ---------------------------------------------------------------------------

export function checkSymbolIsTyphex(symbol: ts.Symbol): boolean {
  const symbolName = symbol.getName();
  if (symbolName !== "Table" && symbolName !== "QueryBuilder") return false;

  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return false;

  for (const decl of declarations) {
    const normalizedPath = decl.getSourceFile().fileName.replace(/\\/g, "/");
    const isTyphex =
      (normalizedPath.includes("/typhex/") || normalizedPath.includes("/typhex\\")) &&
      (normalizedPath.includes("/orm/table") || normalizedPath.includes("/orm/query-builder")) &&
      (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".js") || normalizedPath.endsWith(".d.ts"));
    if (!isTyphex) return false;
  }
  return true;
}

export function isTyphexType(receiver: ts.Expression, checker: ts.TypeChecker): boolean {
  try {
    const receiverType = checker.getTypeAtLocation(receiver);
    let typeSymbol = receiverType.getSymbol();

    if (!typeSymbol) {
      const constructorProp = receiverType.getProperties().find(p => p.getName() === "constructor");
      if (constructorProp) {
        const sigs = checker.getTypeOfSymbolAtLocation(constructorProp, receiver).getCallSignatures();
        if (sigs.length > 0) typeSymbol = sigs[0].getReturnType().getSymbol();
      }
    }
    if (!typeSymbol && receiverType.aliasSymbol) typeSymbol = receiverType.aliasSymbol;
    return typeSymbol ? checkSymbolIsTyphex(typeSymbol) : false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Member path resolution (supports multiple param names for join predicates)
// ---------------------------------------------------------------------------

export interface ResolvedMember {
  param: string;
  path: string[];
}

/**
 * Walk a property access chain and return { param, path }.
 * Supports multiple param names (e.g. ["u", "posts"]) so (u, posts) => u.id === posts.authorId works.
 * When paramNames has one entry, param is always that entry.
 */
export function resolveMemberPath(
  expr: ts.PropertyAccessExpression,
  paramNames: string[]
): ResolvedMember | null {
  const parts: string[] = [];
  let current: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current) && paramNames.includes(current.text)) {
    return { param: current.text, path: parts };
  }
  return null;
}

/**
 * Convenience overload: single param name, returns just the path (backward-compatible).
 */
export function memberPath(
  expr: ts.PropertyAccessExpression,
  paramName: string
): string[] | null {
  const result = resolveMemberPath(expr, [paramName]);
  return result ? result.path : null;
}

// ---------------------------------------------------------------------------
// Unwrap parenthesized expression → object literal
// ---------------------------------------------------------------------------

export function unwrapObjectLiteral(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  return ts.isObjectLiteralExpression(inner) ? inner : null;
}

// ---------------------------------------------------------------------------
// TS SyntaxKind → IR binary op
// ---------------------------------------------------------------------------

const BINARY_OP_MAP: Record<number, IrBinary["op"] | "in" | undefined> = {
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

export function binaryOpFromSyntaxKind(kind: ts.SyntaxKind): IrBinary["op"] | "in" | null {
  return BINARY_OP_MAP[kind] ?? null;
}

// ---------------------------------------------------------------------------
// IR → ts.ObjectLiteralExpression (used by both where and select transformers)
// ---------------------------------------------------------------------------

function valueToTsExpression(value: unknown, f: ts.NodeFactory): ts.Expression {
  if (value === null) return f.createNull();
  switch (typeof value) {
    case "string":
      return f.createStringLiteral(value);
    case "number":
      return f.createNumericLiteral(value);
    case "boolean":
      return value ? f.createTrue() : f.createFalse();
    default:
      if (Array.isArray(value)) {
        return f.createArrayLiteralExpression(
          (value as unknown[]).map(v => valueToTsExpression(v, f))
        );
      }
      return f.createStringLiteral(String(value));
  }
}

export function irNodeToTsLiteral(ir: IrNode): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("kind", f.createStringLiteral(ir.kind)),
  ];

  switch (ir.kind) {
    case "binary":
      props.push(f.createPropertyAssignment("op", f.createStringLiteral(ir.op)));
      props.push(f.createPropertyAssignment("left", irNodeToTsLiteral(ir.left)));
      props.push(f.createPropertyAssignment("right", irNodeToTsLiteral(ir.right)));
      break;
    case "unary":
      props.push(f.createPropertyAssignment("op", f.createStringLiteral(ir.op)));
      props.push(f.createPropertyAssignment("operand", irNodeToTsLiteral(ir.operand)));
      break;
    case "member":
      props.push(f.createPropertyAssignment("param", f.createStringLiteral(ir.param)));
      props.push(f.createPropertyAssignment("path",
        f.createArrayLiteralExpression(ir.path.map(p => f.createStringLiteral(p)))
      ));
      break;
    case "const":
      props.push(f.createPropertyAssignment("value", valueToTsExpression(ir.value, f)));
      break;
    case "param":
      props.push(f.createPropertyAssignment("key", f.createStringLiteral(ir.key)));
      break;
    case "in":
      props.push(f.createPropertyAssignment("left", irNodeToTsLiteral(ir.left)));
      props.push(f.createPropertyAssignment("right", irNodeToTsLiteral(ir.right)));
      break;
    case "call":
      props.push(f.createPropertyAssignment("method", f.createStringLiteral(ir.method)));
      props.push(f.createPropertyAssignment("receiver", irNodeToTsLiteral(ir.receiver)));
      props.push(f.createPropertyAssignment("args",
        f.createArrayLiteralExpression(ir.args.map((a) => irNodeToTsLiteral(a)))
      ));
      break;
    case "exists":
      props.push(f.createPropertyAssignment("rootParam", f.createStringLiteral(ir.rootParam)));
      props.push(f.createPropertyAssignment("relationKey", f.createStringLiteral(ir.relationKey)));
      props.push(f.createPropertyAssignment("innerParam", f.createStringLiteral(ir.innerParam)));
      props.push(f.createPropertyAssignment("innerWhere", irNodeToTsLiteral(ir.innerWhere)));
      break;
    case "aggregate":
      return irAggregateToTsLiteral(ir as IrAggregate);
  }
  return f.createObjectLiteralExpression(props);
}

export function irOrderByToTsLiteral(ir: IrOrderBy): ts.ObjectLiteralExpression {
  const f = ts.factory;
  return f.createObjectLiteralExpression([
    f.createPropertyAssignment("param", f.createStringLiteral(ir.param)),
    f.createPropertyAssignment("path",
      f.createArrayLiteralExpression(ir.path.map(p => f.createStringLiteral(p)))
    ),
    f.createPropertyAssignment("direction", f.createStringLiteral(ir.direction)),
  ]);
}

export function irAggregateToTsLiteral(agg: IrAggregate): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("kind", f.createStringLiteral("aggregate")),
    f.createPropertyAssignment("func", f.createStringLiteral(agg.func)),
    f.createPropertyAssignment("arg", agg.arg ? irNodeToTsLiteral(agg.arg) : f.createNull()),
  ];
  if (agg.alias) props.push(f.createPropertyAssignment("alias", f.createStringLiteral(agg.alias)));
  if (agg.distinct) props.push(f.createPropertyAssignment("distinct", f.createTrue()));
  if (agg.separator !== undefined) props.push(f.createPropertyAssignment("separator", f.createStringLiteral(agg.separator)));
  return f.createObjectLiteralExpression(props);
}

export function irSelectToTsLiteral(sel: IrSelect): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("param", f.createStringLiteral(sel.param)),
    f.createPropertyAssignment("paths",
      f.createArrayLiteralExpression(
        sel.paths.map(path => f.createArrayLiteralExpression(path.map(p => f.createStringLiteral(p))))
      )
    ),
  ];
  if (sel.aliases && sel.aliases.length > 0) {
    props.push(f.createPropertyAssignment("aliases",
      f.createArrayLiteralExpression(sel.aliases.map(a => f.createStringLiteral(a)))
    ));
  }
  if (sel.rest) {
    props.push(f.createPropertyAssignment("rest", f.createTrue()));
  }
  if (sel.aggregates && sel.aggregates.length > 0) {
    props.push(f.createPropertyAssignment("aggregates",
      f.createArrayLiteralExpression(sel.aggregates.map(irAggregateToTsLiteral))
    ));
  }
  if (sel.groupBy && sel.groupBy.length > 0) {
    props.push(f.createPropertyAssignment("groupBy",
      f.createArrayLiteralExpression(
        sel.groupBy.map(entry =>
          typeof entry === "number"
            ? f.createNumericLiteral(entry)
            : f.createArrayLiteralExpression(entry.map(p => f.createStringLiteral(p)))
        )
      )
    ));
  }
  return f.createObjectLiteralExpression(props);
}
