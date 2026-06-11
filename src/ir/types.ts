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
  | IrExists
  | IrAggregate
  | IrSubqueryRef
  | IrCase;

export interface IrPredicate {
  node: IrNode;
  rootParam: string;
  localParamNames?: string[];
}

export type IrWhere = IrPredicate;
export type IrHaving = IrPredicate;

export interface IrBinary {
  kind: "binary";
  op:
    | "&&" | "||"
    | "===" | "!==" | "==" | "!="
    | ">" | ">=" | "<" | "<="
    | "+" | "-" | "*" | "/" | "%"
    | "&" | "|" | "^" | "<<" | ">>";
  left: IrNode;
  right: IrNode;
}

export interface IrCase {
  kind: "case";
  branches: Array<{ when: IrNode; then: IrNode }>;
  else?: IrNode;
}

export interface IrUnary {
  kind: "unary";
  op: "!" | "~";
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

export interface IrSubqueryRef {
  kind: "subqueryRef";
  key: string;
}

export interface IrAggregate {
  kind: "aggregate";
  func:
    | "SUM"
    | "AVG"
    | "MIN"
    | "MAX"
    | "COUNT" // cross-dialect
    | "GROUP_CONCAT" // SQLite
    | "STRING_AGG"
    | "ARRAY_AGG"
    | "JSON_AGG"; // PostgreSQL
  arg: IrNode | null; // null for COUNT(*)
  alias?: string;
  distinct?: boolean;
  separator?: string; // for GROUP_CONCAT / STRING_AGG
}

/** Sort direction for `orderBy`: `'asc'` (ascending) or `'desc'` (descending). */
export type OrderDirection = "asc" | "desc";

export interface IrOrderBy {
  /** Sort key — typically an IrMember (column path) or IrSubqueryRef (scalar subquery). */
  expr: IrNode;
  direction: OrderDirection;
}

/** Relation to load: name, output key, optional sub-paths and query options. */
export interface IrSelectRelation {
  name: string;
  outputKey: string;
  /** Columns to select from target; undefined = all columns. */
  subPaths?: string[][];
  /** Optional: filter for the relation sub-query. */
  whereIr?: IrWhere;
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
  /** Aggregate columns in SELECT (SUM, AVG, MIN, MAX, COUNT). */
  aggregates?: IrAggregate[];
  /** Scalar subquery columns in SELECT (e.g. `(SELECT COUNT(*) FROM …) AS "x"`). */
  subqueries?: Array<{ alias: string; subquery: IrSubqueryRef }>;
  /** Computed expression columns (arithmetic, ternary, etc.). Emitted as inline-literal SQL. */
  expressions?: Array<{ expr: IrNode; alias: string }>;
  /** GROUP BY entries: string[] = member path, number = positional column reference (GROUP BY 1). */
  groupBy?: Array<string[] | number>;
}

export type JoinType = "inner" | "left" | "right" | "cross" | "full";

export interface JoinHint {
  relationKey: string;
  joinType: JoinType;
}

/** JOIN to an entity table with a custom ON predicate (not a declared relation). */
export interface EntityJoinHint {
  joinType: JoinType;
  entity: { table: { _table: string; _schema: Record<string, string> } };
  onIr: IrWhere;
}

export function isIrOrderBy(value: unknown): value is IrOrderBy {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return isIrNode(v.expr) && (v.direction === "asc" || v.direction === "desc");
}

export function isIrWhere(value: unknown): value is IrWhere {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return isIrNode(v.node) && typeof v.rootParam === "string";
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
    k === "exists" ||
    k === "aggregate" ||
    k === "subqueryRef" ||
    k === "case"
  );
}

export function isIrSelect(node: unknown): node is IrSelect {
  if (node == null || typeof node !== "object") return false;
  const o = node as Record<string, unknown>;
  if (typeof o.param !== "string" || !Array.isArray(o.paths)) return false;
  if (
    !o.paths.every(
      (p: unknown) =>
        Array.isArray(p) && (p as unknown[]).every((x: unknown) => typeof x === "string"),
    )
  )
    return false;
  if (o.rest !== undefined && typeof o.rest !== "boolean") return false;
  if (o.relations !== undefined) {
    if (!Array.isArray(o.relations)) return false;
    if (
      !o.relations.every((r: unknown) => {
        const x = r as Record<string, unknown>;
        return (
          x &&
          typeof x.name === "string" &&
          typeof x.outputKey === "string" &&
          (x.subPaths === undefined ||
            (Array.isArray(x.subPaths) &&
              x.subPaths.every(
                (p: unknown) =>
                  Array.isArray(p) && (p as unknown[]).every((s: unknown) => typeof s === "string"),
              ))) &&
          (x.whereIr === undefined || isIrWhere(x.whereIr)) &&
          (x.orderBy === undefined ||
            (Array.isArray(x.orderBy) && x.orderBy.every(isIrOrderBy)))
        );
      })
    )
      return false;
  }
  if (o.aggregates !== undefined) {
    if (!Array.isArray(o.aggregates)) return false;
    if (
      !o.aggregates.every((a: unknown) => {
        const x = a as Record<string, unknown>;
        return x && x.kind === "aggregate" && typeof x.func === "string";
      })
    )
      return false;
  }
  if (o.groupBy !== undefined) {
    if (!Array.isArray(o.groupBy)) return false;
  }
  if (o.subqueries !== undefined) {
    if (!Array.isArray(o.subqueries)) return false;
    if (
      !o.subqueries.every((s: unknown) => {
        const x = s as Record<string, unknown>;
        const sub = x?.subquery as Record<string, unknown> | undefined;
        return (
          x &&
          typeof x.alias === "string" &&
          sub != null &&
          sub.kind === "subqueryRef" &&
          typeof sub.key === "string"
        );
      })
    )
      return false;
  }
  if (o.expressions !== undefined) {
    if (!Array.isArray(o.expressions)) return false;
    if (
      !o.expressions.every((e: unknown) => {
        const x = e as Record<string, unknown>;
        return x && typeof x.alias === "string" && isIrNode(x.expr);
      })
    )
      return false;
  }
  return true;
}
