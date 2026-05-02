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
  | IrSubquery;

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

/** Subquery IR. Used as the right-hand side of `IN (...)` or as a scalar
 *  column in a SELECT list. Always carries an `IrSelect` projecting exactly
 *  one column (a member path or an aggregate); call `validateIrSubquery` to
 *  enforce that invariant. */
export interface IrSubquery {
  kind: "subquery";
  tableName: string;
  /** Single-column projection: either one member path or one aggregate. */
  selectIr: IrSelect;
  whereIr: IrNode | null;
  /** Names of row params bound by the subquery's own WHERE lambda
   *  (e.g. `["p"]` for `Post.query().where(p => …)`). */
  innerParamNames?: string[];
  /** Names of params the subquery's WHERE references against the *outer* query.
   *  When set, only these names map to the outer paramToAlias; everything else
   *  in `whereIr` belongs to the subquery's own scope (innerParamNames). */
  outerCorrelatedParams?: string[];
  /** Optional ORDER BY applied inside the subquery. Each entry sorts by an
   *  inner column (typically `IrMember` against the subquery's own row). */
  orderBy?: IrOrderBy[];
  /** Optional LIMIT applied inside the subquery. Literal numeric only. */
  limitNum?: number;
  /** Optional OFFSET applied inside the subquery. Literal numeric only. */
  offsetNum?: number;
  /** DISTINCT modifier. For aggregate-column form, `{ col }` emits
   *  `<func>(DISTINCT col)`. For path-column form, `true` emits
   *  `SELECT DISTINCT <col>`. */
  distinct?: { col: string } | true;
}

/** Inspect `whereIr` (and optionally `orderBy` exprs); return param names
 *  referenced that are NOT in `innerParamNames` — i.e. the correlated outer
 *  references. Used to mark which IrParam/IrMember names should resolve in
 *  the outer query's scope rather than the subquery's own. */
export function computeOuterCorrelatedParams(
  whereIr: IrNode | null,
  innerParamNames: string[],
  orderBy?: IrOrderBy[],
): string[] {
  const seen = new Set<string>();
  if (whereIr) collectParamNamesFromWhere(whereIr, seen);
  if (orderBy) {
    for (const ob of orderBy) collectParamNamesFromWhere(ob.expr, seen);
  }
  if (seen.size === 0) return [];
  const inner = new Set(innerParamNames);
  const out: string[] = [];
  for (const n of seen) if (!inner.has(n)) out.push(n);
  return out;
}

/** Validate an IrSubquery's invariants. Throws when malformed.
 *  - `selectIr` must project exactly one column (one path xor one aggregate).
 *  - Aggregates other than COUNT require an arg (or a DISTINCT col in `distinct`). */
export function validateIrSubquery(sub: IrSubquery): void {
  const sel = sub.selectIr;
  if (!sel) {
    throw new Error("[typhex] Subquery requires selectIr");
  }
  const pathCount = sel.paths.length;
  const aggCount = sel.aggregates?.length ?? 0;
  const total = pathCount + aggCount;
  if (total !== 1) {
    throw new Error(
      `[typhex] Subquery must select exactly one column (got ${total}: ${pathCount} path(s) + ${aggCount} aggregate(s))`,
    );
  }
  if (sel.rest) {
    throw new Error("[typhex] Subquery cannot use rest projection");
  }
  if (sel.subqueries && sel.subqueries.length > 0) {
    throw new Error("[typhex] Subquery cannot nest scalar subquery columns");
  }
  if (aggCount === 1) {
    const agg = sel.aggregates![0];
    const distinctCol =
      sub.distinct && typeof sub.distinct === "object" ? sub.distinct.col : undefined;
    if (agg.func !== "COUNT" && agg.arg === null && distinctCol === undefined) {
      throw new Error(`[typhex] ${agg.func} subquery requires a column argument`);
    }
  }
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
  /** Sort key — typically an IrMember (column path) or IrSubquery (scalar subquery). */
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
  /** Aggregate columns in SELECT (SUM, AVG, MIN, MAX, COUNT). */
  aggregates?: IrAggregate[];
  /** Scalar subquery columns in SELECT (e.g. `(SELECT COUNT(*) FROM …) AS "x"`). */
  subqueries?: Array<{ alias: string; subquery: IrSubquery }>;
  /** GROUP BY entries: string[] = member path, number = positional column reference (GROUP BY 1). */
  groupBy?: Array<string[] | number>;
}

export type JoinType = "inner" | "left" | "right" | "cross" | "full";

export const JOIN_SQL_KEYWORDS: Record<JoinType, string> = {
  inner: "INNER JOIN",
  left: "LEFT JOIN",
  right: "RIGHT JOIN",
  cross: "CROSS JOIN",
  full: "FULL OUTER JOIN",
};

export interface JoinHint {
  relationKey: string;
  joinType: JoinType;
}

export function isIrOrderBy(value: unknown): value is IrOrderBy {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return isIrNode(v.expr) && (v.direction === "asc" || v.direction === "desc");
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
    k === "subquery"
  );
}

/** Inline `IrParam` nodes in a tree to `IrConst` using `values` (key → value).
 *  Pure rewrite: returns a fresh tree, original is untouched. The right-hand
 *  side of an `IrSubquery` is left as-is — its params live in their own scope. */
export function inlineParams(ir: IrNode, values: Record<string, unknown>): IrNode {
  switch (ir.kind) {
    case "param":
      return { kind: "const", value: values[ir.key] };
    case "binary":
      return {
        ...ir,
        left: inlineParams(ir.left, values),
        right: inlineParams(ir.right, values),
      };
    case "unary":
      return { ...ir, operand: inlineParams(ir.operand, values) };
    case "in":
      return {
        ...ir,
        left: inlineParams(ir.left, values),
        right:
          ir.right.kind === "subquery" || ir.right.kind === "param" || ir.right.kind === "const"
            ? ir.right
            : inlineParams(ir.right, values),
      };
    case "call":
      return {
        ...ir,
        receiver: inlineParams(ir.receiver, values),
        args: ir.args.map((a) => inlineParams(a, values)),
      };
    default:
      return ir;
  }
}

/** Recursively gather every row-parameter name referenced inside an IrWhere tree
 *  (e.g. "u" from `u.name === "Alice"`). */
export function collectParamNamesFromWhere(node: IrNode, out: Set<string>): void {
  switch (node.kind) {
    case "member":
      out.add(node.param);
      break;
    case "binary":
      collectParamNamesFromWhere(node.left, out);
      collectParamNamesFromWhere(node.right, out);
      break;
    case "unary":
      collectParamNamesFromWhere(node.operand, out);
      break;
    case "in":
      collectParamNamesFromWhere(node.left, out);
      collectParamNamesFromWhere(node.right, out);
      break;
    case "call":
      collectParamNamesFromWhere(node.receiver, out);
      for (const a of node.args) collectParamNamesFromWhere(a, out);
      break;
    case "exists":
      out.add(node.rootParam);
      break;
    default:
      break;
  }
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
          (x.whereIr === undefined || isIrNode(x.whereIr)) &&
          (x.orderBy === undefined ||
            (Array.isArray(x.orderBy) &&
              x.orderBy.every(
                (o: unknown) =>
                  typeof o === "object" &&
                  o !== null &&
                  "param" in o &&
                  "path" in o &&
                  "direction" in o,
              )))
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
          sub.kind === "subquery" &&
          typeof sub.tableName === "string"
        );
      })
    )
      return false;
  }
  return true;
}
