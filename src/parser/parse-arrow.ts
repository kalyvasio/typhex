/**
 * Runtime parser: arrow function source → IR.
 * Supports a safe subset: comparisons, &&, ||, !, member access, literals, identifiers (params).
 */

import * as acorn from "acorn";
import type {
  IrNode,
  IrBinary,
  IrUnary,
  IrMember,
  IrConst,
  IrParam,
  IrIn,
  IrCall,
} from "../ir/types.js";

type AcornNode = acorn.Node;

const BINARY_OP_MAP: Record<string, IrBinary["op"] | undefined> = {
  "&&": "&&",
  "||": "||",
  "==": "==",
  "===": "===",
  "!=": "!=",
  "!==": "!==",
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
};

const ALLOWED_METHODS = new Set(["startsWith", "endsWith", "includes"]);

export interface ParseOptions {
  /** Parameter name expected in the arrow (e.g. "u"). Used for member path. */
  paramName?: string;
  /** Names of outer variables to treat as param keys (captured in closure). */
  paramKeys?: string[];
}

/**
 * Parse an arrow function's string representation into IR.
 * Only supports expression-bodied arrows: (x) => x.age > 18
 */
export function parseArrowToIr(
  fn: (...args: unknown[]) => unknown,
  options: ParseOptions = {}
): IrNode {
  const src = fn.toString();
  const expr = extractArrowBodyExpression(src);
  if (!expr) throw new Error("Could not extract arrow body: " + src);

  const ast = acorn.parse(expr, {
    ecmaVersion: "latest",
    locations: true,
  }) as { body: Array<{ expression?: AcornNode }> };

  const statement = ast.body[0];
  const node = statement && "expression" in statement ? statement.expression : null;
  if (!node) throw new Error("Expected expression: " + expr);

  const paramName = options.paramName ?? inferParamName(src);
  const paramKeys = options.paramKeys ?? [];

  return walk(node, paramName, paramKeys);
}

function extractArrowBodyExpression(src: string): string | null {
  const trimmed = src.replace(/^\s*async\s+/, "").trim();
  const arrowIdx = trimmed.indexOf("=>");
  if (arrowIdx === -1) return null;
  let body = trimmed.slice(arrowIdx + 2).trim();
  if (body.startsWith("{")) {
    // Block body - we don't support
    return null;
  }
  return body;
}

function inferParamName(src: string): string {
  const arrowIdx = src.indexOf("=>");
  if (arrowIdx === -1) return "u";
  const before = src.slice(0, arrowIdx).trim();
  const match = before.match(/\(([^)]*)\)/) || before.match(/(\w+)\s*=>/);
  const params = match ? match[1].split(",").map((p) => p.trim()) : [];
  return params[0] || "u";
}

function walk(
  node: AcornNode,
  paramName: string,
  paramKeys: string[]
): IrNode {
  const n = node as {
    type: string;
    left?: AcornNode;
    right?: AcornNode;
    argument?: AcornNode;
    operand?: AcornNode;
    object?: AcornNode;
    property?: AcornNode;
    computed?: boolean;
    name?: string;
    value?: unknown;
    callee?: AcornNode;
    arguments?: AcornNode[];
    operator?: string;
  };

  switch (n.type) {
    case "BinaryExpression": {
      const op = n.operator && BINARY_OP_MAP[n.operator];
      if (!op && n.operator !== "in") {
        throw new Error("Unsupported binary operator: " + n.operator);
      }
      if (n.operator === "in") {
        return {
          kind: "in",
          left: walk(n.left!, paramName, paramKeys),
          right: walk(n.right!, paramName, paramKeys),
        } as IrIn;
      }
      return {
        kind: "binary",
        op,
        left: walk(n.left!, paramName, paramKeys),
        right: walk(n.right!, paramName, paramKeys),
      } as IrBinary;
    }
    case "LogicalExpression": {
      const op = (n.operator === "&&" ? "&&" : "||") as "&&" | "||";
      return {
        kind: "binary",
        op,
        left: walk(n.left!, paramName, paramKeys),
        right: walk(n.right!, paramName, paramKeys),
      } as IrBinary;
    }
    case "UnaryExpression": {
      if (n.operator !== "!") throw new Error("Unsupported unary: " + n.operator);
      return {
        kind: "unary",
        op: "!",
        operand: walk(n.argument ?? n.operand!, paramName, paramKeys),
      } as IrUnary;
    }
    case "MemberExpression": {
      const path = memberPath(n, paramName);
      if (path) return { kind: "member", param: paramName, path } as IrMember;
      throw new Error("Unsupported member expression");
    }
    case "Identifier": {
      const name = n.name ?? "";
      if (name === paramName) {
        return { kind: "member", param: paramName, path: [] } as IrMember;
      }
      if (paramKeys.includes(name)) return { kind: "param", key: name } as IrParam;
      throw new Error("Unknown identifier (not param or entity): " + name);
    }
    case "Literal": {
      return { kind: "const", value: n.value } as IrConst;
    }
    case "CallExpression": {
      const callee = n.callee as {
        type: string;
        object?: AcornNode;
        property?: { name?: string };
        name?: string;
      };
      if (callee.type === "MemberExpression") {
        const method =
          callee.property && "name" in callee.property
            ? callee.property.name
            : undefined;
        if (!method || !ALLOWED_METHODS.has(method))
          throw new Error("Unsupported method: " + method);
        const receiver = walk(callee.object!, paramName, paramKeys);
        const args = (n.arguments ?? []).map((a) => walk(a as import("acorn").Node, paramName, paramKeys));
        return { kind: "call", method, receiver, args } as IrCall;
      }
      throw new Error("Unsupported call expression");
    }
    case "ArrayExpression": {
      const elements = (n as AcornNode & { elements: AcornNode[] }).elements ?? [];
      const arr = elements.map((e) => {
        if (!e || (e as { type: string }).type === "SpreadElement")
          throw new Error("Unsupported array element");
        const ir = walk(e, paramName, paramKeys);
        if (ir.kind !== "const") throw new Error("IN array must contain literals");
        return ir.value;
      });
      return { kind: "const", value: arr } as IrConst;
    }
    default:
      throw new Error("Unsupported node type: " + (n as { type: string }).type);
  }
}

function memberPath(
  node: {
    type: string;
    object?: AcornNode;
    property?: AcornNode;
    computed?: boolean;
  },
  paramName: string
): string[] | null {
  if (node.type !== "MemberExpression") return null;
  const obj = node.object! as AcornNode & { name?: string };
  const prop = node.property as AcornNode & { name?: string };
  if (node.computed || !prop || prop.type !== "Identifier") return null;
  const rest =
    obj.type === "MemberExpression"
      ? memberPath(obj as unknown as typeof node, paramName)
      : obj.type === "Identifier" && obj.name === paramName
        ? []
        : null;
  if (rest === null) return null;
  return [...rest, prop.name!];
}
