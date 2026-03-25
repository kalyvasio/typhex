/**
 * Query Intermediate Representation (IR).
 * Produced by the TS transformer or runtime parser; consumed by the SQL compiler.
 */

export type IrNode =
  | IrBinary
  | IrUnary
  | IrMember
  | IrConst
  | IrParam
  | IrCall
  | IrIn
  | IrExists;

export interface IrBinary {
  kind: "binary";
  op: "&&" | "||" | "===" | "!==" | ">" | ">=" | "<" | "<=" | "==" | "!=";
  left: IrNode;
  right: IrNode;
}

export interface IrUnary {
  kind: "unary";
  op: "!";
  operand: IrNode;
}

export interface IrMember {
  kind: "member";
  /** Parameter name (e.g. "u") and property path ["age"] => u.age */
  param: string;
  path: string[];
}

export interface IrConst {
  kind: "const";
  value: unknown;
}

export interface IrParam {
  kind: "param";
  /** Runtime key to look up in params map */
  key: string;
}

export interface IrIn {
  kind: "in";
  left: IrNode;
  right: IrNode; // IrConst with array value or IrParam
  negated?: boolean;
}

/** EXISTS subquery for one-to-many: relation.some(e => predicate) or relation.every(e => predicate).
 *  negated: true → every() → NOT EXISTS (... WHERE NOT (predicate)) */
export interface IrExists {
  kind: "exists";
  negated?: boolean;
  rootParam: string;
  relationKey: string;
  innerParam: string;
  innerWhere: IrNode;
}

export interface IrCall {
  kind: "call";
  /** e.g. "startsWith", "includes" */
  method: string;
  receiver: IrNode;
  args: IrNode[];
}

export type OrderDirection = "asc" | "desc";

export interface IrOrderBy {
  param: string;
  path: string[];
  direction: OrderDirection;
}

/** Relation to load: name, output key, optional sub-paths and query options. */
export interface IrSelectRelation {
  name: string;
  outputKey: string;
  /** Columns to select from target; undefined = all columns. */
  subPaths?: string[][];
  /** Optional: filter for the relation sub-query. */
  whereIr?: IrNode;
  whereParams?: Record<string, unknown>;
  /** Optional: order for the relation sub-query. */
  orderBy?: IrOrderBy[];
  limitNum?: number | null;
  offsetNum?: number | null;
}

export interface IrSelect {
  param: string;
  /** Empty = select all columns for this param */
  paths: string[][];
  /** Optional output names (SQL AS). Same length as paths; when set, path[i] is selected as aliases[i]. */
  aliases?: string[];
  /** If true, select paths plus all other table columns not in paths (e.g. ({ id, ...rest }) => ({ id, ...rest })). */
  rest?: boolean;
  /** Relations to load (manyToOne, oneToOne, oneToMany, manyToMany). Loaded via separate queries. */
  relations?: IrSelectRelation[];
}

export function isIrNode(node: unknown): node is IrNode {
  if (node == null || typeof node !== "object") return false;
  const k = (node as { kind?: string }).kind;
  return (
    k === "binary" ||
    k === "unary" ||
    k === "member" ||
    k === "const" ||
    k === "param" ||
    k === "in" ||
    k === "call" ||
    k === "exists"
  );
}

export function isIrSelect(node: unknown): node is IrSelect {
  if (node == null || typeof node !== "object") return false;
  const o = node as Record<string, unknown>;
  if (typeof o.param !== "string" || !Array.isArray(o.paths)) return false;
  if (!o.paths.every((p: unknown) => Array.isArray(p) && (p as unknown[]).every((x: unknown) => typeof x === "string"))) return false;
  if (o.rest !== undefined && typeof o.rest !== "boolean") return false;
  if (o.relations !== undefined) {
    if (!Array.isArray(o.relations)) return false;
    if (!o.relations.every((r: unknown) => {
      const x = r as Record<string, unknown>;
      return x && typeof x.name === "string" && typeof x.outputKey === "string" &&
        (x.subPaths === undefined || (Array.isArray(x.subPaths) && x.subPaths.every((p: unknown) =>
          Array.isArray(p) && (p as unknown[]).every((s: unknown) => typeof s === "string")))) &&
        (x.whereIr === undefined || isIrNode(x.whereIr)) &&
        (x.orderBy === undefined || (Array.isArray(x.orderBy) && x.orderBy.every((o: unknown) =>
          typeof o === "object" && o !== null && "param" in o && "path" in o && "direction" in o)));
    })) return false;
  }
  return true;
}
