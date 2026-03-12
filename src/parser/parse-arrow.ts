/**
 * Runtime parser: arrow function source → IR.
 * Supports a safe subset: comparisons, &&, ||, !, member access, literals, identifiers (params).
 * Also supports parsing select lambdas: (u) => ({ id: u.id, name: u.name }) → IrSelect.
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
  IrSelect,
  IrSelectRelation,
  IrOrderBy,
} from "../ir/types.js";

type AcornNode = acorn.Node;

const BINARY_OPS: Record<string, IrBinary["op"] | undefined> = {
  "&&": "&&", "||": "||",
  "==": "==", "===": "===", "!=": "!=", "!==": "!==",
  ">": ">", ">=": ">=", "<": "<", "<=": "<=",
};

const ALLOWED_METHODS = new Set(["startsWith", "endsWith", "includes"]);

export interface ParseOptions {
  paramName?: string;
  paramNames?: string[];
  paramKeys?: string[];
}

// ---------------------------------------------------------------------------
// Public API: parseArrowToIr (where predicates)
// ---------------------------------------------------------------------------

export function parseArrowToIr(
  fn: (...args: any[]) => any,
  options: ParseOptions = {}
): IrNode {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) throw new Error("Could not extract arrow body: " + src);

  const expr = parseExpression(body);
  const params =
    options.paramNames ??
    (options.paramName ? [options.paramName] : inferParamNames(src));

  return walk(expr, params, options.paramKeys ?? []);
}

// ---------------------------------------------------------------------------
// Public API: parseArrowToIrSelect (select lambdas)
// ---------------------------------------------------------------------------

export function parseArrowToIrSelect(
  fn: (...args: any[]) => any
): IrSelect | null {
  const src = fn.toString();
  const body = extractArrowBody(src);
  if (!body) return null;

  const paramName = inferParamNames(src)[0] ?? "u";

  let exprSrc = body;
  if (exprSrc.startsWith("(") && exprSrc.endsWith(")")) {
    exprSrc = exprSrc.slice(1, -1);
  }

  const fullSrc = `(${exprSrc})`;
  let ast: { body: Array<{ expression?: AcornNode }> };
  try {
    ast = acorn.parse(fullSrc, { ecmaVersion: "latest", locations: true }) as typeof ast;
  } catch {
    return null;
  }

  const expr = ast.body[0]?.expression;
  if (!expr || (expr as { type: string }).type !== "ObjectExpression") return null;

  const obj = expr as AcornNode & { properties: AcornNode[] };
  const paths: string[][] = [];
  const aliases: string[] = [];
  const relations: IrSelectRelation[] = [];

  for (const raw of obj.properties) {
    const prop = raw as AcornNode & {
      type: string;
      key?: AcornNode & { name?: string; value?: string };
      value?: AcornNode;
      computed?: boolean;
      shorthand?: boolean;
    };
    if (prop.type === "SpreadElement") return null;
    if (prop.type !== "Property") return null;
    if (prop.computed) return null;

    const keyName = prop.key?.name ?? prop.key?.value;
    if (typeof keyName !== "string") return null;

    const val = prop.value;
    if (!val) return null;

    const valType = (val as { type: string }).type;

    if (valType === "ObjectExpression") {
      const sub = parseRelationSubSelect(val as AcornNode & { properties: AcornNode[] }, paramName);
      if (!sub) return null;
      relations.push({ name: sub.relation, outputKey: keyName, subPaths: sub.subPaths });
    } else if (valType === "CallExpression") {
      const rel = parseRelationQueryChain(val as AcornNode & { callee: AcornNode; arguments: AcornNode[] }, paramName, keyName, fullSrc);
      if (!rel) return null;
      relations.push(rel);
    } else {
      const resolved = resolveMemberFromAcorn(val as AcornNode & { type: string; object?: AcornNode; property?: AcornNode; computed?: boolean; name?: string }, [paramName]);
      if (!resolved || resolved.path.length === 0) return null;
      paths.push(resolved.path);
      aliases.push(keyName);
    }
  }

  if (paths.length === 0 && relations.length === 0) return null;
  const result: IrSelect = { param: paramName, paths, aliases };
  if (relations.length > 0) result.relations = relations;
  return result;
}

/** Parse nested object like { id: p.author.id, name: p.author.name } → relation "author" with subPaths. */
function parseRelationSubSelect(
  obj: { properties: AcornNode[] },
  paramName: string
): { relation: string; subPaths: string[][] } | null {
  const subPaths: string[][] = [];
  let relation: string | null = null;

  for (const raw of obj.properties) {
    const prop = raw as AcornNode & {
      type: string;
      key?: AcornNode & { name?: string };
      value?: AcornNode;
      computed?: boolean;
    };
    if (prop.type !== "Property" || prop.computed) return null;

    const keyName = prop.key?.name ?? (prop.key as { value?: string })?.value;
    if (typeof keyName !== "string") return null;

    const val = prop.value;
    if (!val) return null;

    const resolved = resolveMemberFromAcorn(val as AcornNode & { type: string; object?: AcornNode; property?: AcornNode; computed?: boolean; name?: string }, [paramName]);
    if (!resolved || resolved.path.length < 2) return null;

    const rel = resolved.path[0];
    const subPath = resolved.path.slice(1);
    if (relation !== null && relation !== rel) return null;
    relation = rel;
    subPaths.push(subPath);
  }

  if (!relation || subPaths.length === 0) return null;
  return { relation, subPaths };
}

const RELATION_QUERY_METHODS = new Set(["query", "where", "orderBy", "limit", "offset", "select"]);

/** Parse relation.query().where().orderBy().limit().offset().select() chain → IrSelectRelation. */
function parseRelationQueryChain(
  node: AcornNode & { type: string; callee: AcornNode; arguments: AcornNode[] },
  parentParamName: string,
  outputKey: string,
  source: string
): IrSelectRelation | null {
  const methods: { name: string; args: AcornNode[] }[] = [];
  let current: AcornNode | null = node;

  while (current && (current as { type: string }).type === "CallExpression") {
    const call = current as AcornNode & { callee: AcornNode & { type: string; object?: AcornNode; property?: AcornNode & { name?: string } }; arguments: AcornNode[] };
    const callee = call.callee as AcornNode & { type: string; object?: AcornNode; property?: AcornNode & { name?: string } };
    if (callee.type !== "MemberExpression") return null;
    const prop = callee.property as AcornNode & { name?: string };
    const methodName = prop?.name;
    if (!methodName || !RELATION_QUERY_METHODS.has(methodName)) return null;
    methods.push({ name: methodName, args: call.arguments ?? [] });
    current = (callee as { object?: AcornNode }).object ?? null;
  }

  if (!current || (current as { type: string }).type !== "MemberExpression") return null;
  const resolved = resolveMemberFromAcorn(current as AcornNode & { type: string; object?: AcornNode; property?: AcornNode; computed?: boolean; name?: string }, [parentParamName]);
  if (!resolved || resolved.path.length !== 1) return null;

  const relation = resolved.path[0];
  const result: IrSelectRelation = { name: relation, outputKey };

  for (const m of methods) {
    if (m.name === "query") {
      if (m.args.length !== 0) return null;
    } else if (m.name === "where") {
      if (m.args.length !== 1 || (m.args[0] as { type: string }).type !== "ArrowFunctionExpression") return null;
      const arg = m.args[0] as AcornNode & { start?: number; end?: number };
      const argSrc = typeof arg.start === "number" && typeof arg.end === "number" ? source.slice(arg.start, arg.end) : null;
      if (!argSrc) return null;
      try {
        const whereFn = new Function("return " + argSrc)();
        const paramNames = inferParamNames(argSrc);
        const whereIr = parseArrowToIr(whereFn, { paramNames });
        result.whereIr = whereIr;
        result.whereParams = {};
      } catch {
        return null;
      }
    } else if (m.name === "orderBy") {
      if (m.args.length < 1 || m.args.length > 2) return null;
      const col = (m.args[0] as AcornNode & { type: string; value?: string }).type === "Literal"
        ? String((m.args[0] as { value?: string }).value)
        : null;
      if (!col) return null;
      const dir = m.args.length === 2 && (m.args[1] as { value?: string }).value === "desc" ? "desc" : "asc";
      result.orderBy = result.orderBy ?? [];
      result.orderBy.push({ param: "u", path: [col], direction: dir });
    } else if (m.name === "limit") {
      if (m.args.length !== 1) return null;
      const n = (m.args[0] as AcornNode & { type: string; value?: number }).type === "Literal"
        ? Number((m.args[0] as { value?: number }).value)
        : NaN;
      if (!Number.isFinite(n) || n < 0) return null;
      result.limitNum = Math.floor(n);
    } else if (m.name === "offset") {
      if (m.args.length !== 1) return null;
      const n = (m.args[0] as AcornNode & { type: string; value?: number }).type === "Literal"
        ? Number((m.args[0] as { value?: number }).value)
        : NaN;
      if (!Number.isFinite(n) || n < 0) return null;
      result.offsetNum = Math.floor(n);
    } else if (m.name === "select") {
      if (m.args.length !== 1 || (m.args[0] as { type: string }).type !== "ArrowFunctionExpression") return null;
      const arg = m.args[0] as AcornNode & { start?: number; end?: number };
      const argSrc = typeof arg.start === "number" && typeof arg.end === "number" ? source.slice(arg.start, arg.end) : null;
      if (!argSrc) return null;
      try {
        const selectFn = new Function("return " + argSrc)();
        const sub = parseArrowToIrSelect(selectFn);
        if (!sub || !sub.paths.length) return null;
        result.subPaths = sub.paths;
      } catch {
        return null;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Arrow body extraction (supports expression and single-return block bodies)
// ---------------------------------------------------------------------------

function extractArrowBody(src: string): string | null {
  const idx = src.indexOf("=>");
  if (idx === -1) return null;
  const body = src.slice(idx + 2).trim();
  if (!body.startsWith("{")) return body;

  const inner = body.slice(1, -1).trim();
  const returnMatch = inner.match(/^return\s+(.+);?\s*$/s);
  if (!returnMatch) return null;
  return returnMatch[1].replace(/;\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// Parameter name inference
// ---------------------------------------------------------------------------

function inferParamNames(src: string): string[] {
  const idx = src.indexOf("=>");
  if (idx === -1) return ["u"];

  let before = src.slice(0, idx).replace(/^\s*async\s+/, "").trim();

  if (before.startsWith("(") && before.endsWith(")")) {
    before = before.slice(1, -1);
  }
  if (!before) return ["u"];

  const names = before.split(",").map(part => part.trim().split(/[\s:]/)[0]).filter(Boolean);
  return names.length > 0 ? names : ["u"];
}

// ---------------------------------------------------------------------------
// Expression parsing helper
// ---------------------------------------------------------------------------

function parseExpression(exprSrc: string): AcornNode {
  const ast = acorn.parse(exprSrc, { ecmaVersion: "latest" }) as {
    body: Array<{ expression?: AcornNode }>;
  };
  const expr = ast.body[0]?.expression;
  if (!expr) throw new Error("Expected expression: " + exprSrc);
  return expr;
}

// ---------------------------------------------------------------------------
// AST walker: acorn Node → IrNode
// ---------------------------------------------------------------------------

function walk(node: AcornNode, params: string[], paramKeys: string[]): IrNode {
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
    case "BinaryExpression":
    case "LogicalExpression": {
      if (n.operator === "in") {
        return {
          kind: "in",
          left: walk(n.left!, params, paramKeys),
          right: walk(n.right!, params, paramKeys),
        } as IrIn;
      }
      const op = BINARY_OPS[n.operator!];
      if (!op) throw new Error("Unsupported binary operator: " + n.operator);
      return {
        kind: "binary",
        op,
        left: walk(n.left!, params, paramKeys),
        right: walk(n.right!, params, paramKeys),
      } as IrBinary;
    }

    case "UnaryExpression": {
      if (n.operator !== "!") throw new Error("Unsupported unary: " + n.operator);
      return {
        kind: "unary",
        op: "!",
        operand: walk(n.argument ?? n.operand!, params, paramKeys),
      } as IrUnary;
    }

    case "MemberExpression": {
      const result = resolveMemberFromAcorn(n, params);
      if (result) return { kind: "member", param: result.param, path: result.path } as IrMember;
      throw new Error("Unsupported member expression");
    }

    case "Identifier": {
      const name = n.name ?? "";
      if (params.includes(name)) return { kind: "member", param: name, path: [] } as IrMember;
      if (paramKeys.includes(name)) return { kind: "param", key: name } as IrParam;
      throw new Error("Unknown identifier (not param or entity): " + name);
    }

    case "Literal":
      return { kind: "const", value: n.value } as IrConst;

    case "CallExpression": {
      const callee = n.callee as {
        type: string;
        object?: AcornNode;
        property?: { name?: string };
      };
      if (callee.type !== "MemberExpression") throw new Error("Unsupported call expression");
      const method = callee.property?.name;
      if (!method || !ALLOWED_METHODS.has(method))
        throw new Error("Unsupported method: " + method);
      return {
        kind: "call",
        method,
        receiver: walk(callee.object!, params, paramKeys),
        args: (n.arguments ?? []).map((a) => walk(a as AcornNode, params, paramKeys)),
      } as IrCall;
    }

    case "ArrayExpression": {
      const elements = (n as AcornNode & { elements: AcornNode[] }).elements ?? [];
      const arr = elements.map((e) => {
        if (!e || (e as { type: string }).type === "SpreadElement")
          throw new Error("Unsupported array element");
        const ir = walk(e, params, paramKeys);
        if (ir.kind !== "const") throw new Error("IN array must contain literals");
        return ir.value;
      });
      return { kind: "const", value: arr } as IrConst;
    }

    default:
      throw new Error("Unsupported node type: " + (n as { type: string }).type);
  }
}

// ---------------------------------------------------------------------------
// Acorn member path resolution
// ---------------------------------------------------------------------------

function resolveMemberFromAcorn(
  node: { type: string; object?: AcornNode; property?: AcornNode; computed?: boolean; name?: string },
  params: string[]
): { param: string; path: string[] } | null {
  if (node.type === "Identifier" && params.includes(node.name ?? "")) {
    return { param: node.name!, path: [] };
  }
  if (node.type !== "MemberExpression") return null;
  const prop = node.property as AcornNode & { name?: string };
  if (node.computed || !prop || prop.type !== "Identifier") return null;

  const obj = node.object! as AcornNode & { type: string; name?: string; object?: AcornNode; property?: AcornNode; computed?: boolean };
  const parent = resolveMemberFromAcorn(obj, params);
  if (!parent) return null;
  return { param: parent.param, path: [...parent.path, prop.name!] };
}
