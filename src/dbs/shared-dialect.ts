/**
 * Shared SQL compilation logic for SQL dialects.
 *
 * Walks the runtime Expr model (`src/orm/expr.ts`) and emits SQL fragments.
 * No IR imports — the planner has already converted IR → Expr, resolved
 * member paths to (alias, column), and inlined subquery plans.
 *
 * Dialect-specific rendering (EXISTS, LIKE, aggregates, placeholders) is
 * provided by the DialectImpl object passed to makeCompileNode().
 */

import { resolveParamSentinels } from "./types.js";
import type {
  CompileResult,
  CompileQueryOpts,
  DialectImpl,
  ExpandPlaceholdersResult,
} from "./types.js";
import type {
  Expr,
  ExprAggregate,
  ExprColumn,
  GroupByItem,
  OrderItem,
  SelectItem,
} from "../orm/expr.js";
import type { QueryPlan } from "../orm/helpers/query-plan/query-plan.js";
import type { JoinType } from "../ir/types.js";

export const JOIN_SQL_KEYWORDS: Record<JoinType, string> = {
  inner: "INNER JOIN",
  left: "LEFT JOIN",
  right: "RIGHT JOIN",
  cross: "CROSS JOIN",
  full: "FULL OUTER JOIN",
};

export function quoteId(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function renderColumn(col: ExprColumn): string {
  if (col.column.length === 0) return quoteId(col.alias);
  return `${quoteId(col.alias)}.${col.column.map(quoteId).join(".")}`;
}

/** Resolve the SQL expression for an aggregate argument.
 *  Handles: null → *, column → quoted column, numeric const → literal, complex → compileNodeFn. */
export function compileAggregateArg(
  arg: Expr | null,
  compileNodeFn?: (node: Expr, params: unknown[]) => string,
  params?: unknown[],
): string {
  if (arg === null) return "*";
  if (arg.kind === "column") return renderColumn(arg);
  if (arg.kind === "const" && typeof arg.value === "number") {
    return String(arg.value);
  }
  if (compileNodeFn) {
    return compileNodeFn(arg, params ?? []);
  }
  throw new Error(
    `[typhex] Aggregate arg of kind "${arg.kind}" requires a compile context. Use a column expression, a numeric literal, or ensure the aggregate is used within a full query (HAVING/WHERE).`,
  );
}

/** Compile FUNC(DISTINCT? arg) — the standard single-argument aggregate shape. */
export function compileStandardAggregate(
  funcName: string,
  agg: ExprAggregate,
  compileNodeFn?: (node: Expr, params: unknown[]) => string,
  params?: unknown[],
): string {
  const argSql = compileAggregateArg(agg.arg, compileNodeFn, params);
  const distinctPrefix = agg.distinct ? "DISTINCT " : "";
  const expr = `${funcName}(${distinctPrefix}${argSql})`;
  return agg.alias ? `${expr} AS ${quoteId(agg.alias)}` : expr;
}

/** Compile FUNC(DISTINCT? arg[, 'sep']) — the string-concatenation aggregate shape. */
export function compileConcatAggregate(
  funcName: string,
  agg: ExprAggregate,
  defaultSep: string | undefined,
  compileNodeFn?: (node: Expr, params: unknown[]) => string,
  params?: unknown[],
): string {
  const argSql = compileAggregateArg(agg.arg, compileNodeFn, params);
  const distinctPrefix = agg.distinct ? "DISTINCT " : "";
  const sepLiteral =
    agg.separator !== undefined ? `'${agg.separator.replaceAll("'", "''")}'` : defaultSep;
  const inner =
    sepLiteral !== undefined
      ? `${distinctPrefix}${argSql}, ${sepLiteral}`
      : `${distinctPrefix}${argSql}`;
  const expr = `${funcName}(${inner})`;
  return agg.alias ? `${expr} AS ${quoteId(agg.alias)}` : expr;
}

/** Shared aggregate compilation for cross-dialect functions (SUM/AVG/MIN/MAX/COUNT). */
export function compileAggregate(
  agg: ExprAggregate,
  compileNodeFn?: (node: Expr, params: unknown[]) => string,
  params?: unknown[],
): string {
  const CROSS_DIALECT = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT"]);
  if (!CROSS_DIALECT.has(agg.func)) {
    throw new Error(
      `[typhex] Aggregate function "${agg.func}" is dialect-specific. Import it from the corresponding dialect and use with the matching database.`,
    );
  }
  return compileStandardAggregate(agg.func, agg, compileNodeFn, params);
}

/** Compile a GROUP BY clause body. */
export function compileGroupBy(items: GroupByItem[]): string {
  return items
    .map((entry) => {
      if (entry.kind === "index") return String(entry.index);
      return renderColumn(entry);
    })
    .join(", ");
}

type CompileNodeFn = (node: Expr, params: unknown[]) => string;

function compileSubqueryPlan(
  plan: QueryPlan,
  outerParams: unknown[],
  dialect: DialectImpl,
): string {
  const compiled = dialect.compilePlan(plan, {
    wrap: true,
    paramStartIndex: outerParams.length + 1,
  });
  outerParams.push(...compiled.params);
  return compiled.sql;
}

function compileInNode(
  node: Expr & { kind: "in" },
  params: unknown[],
  dialect: DialectImpl,
  compileNode: CompileNodeFn,
): string {
  const left = compileNode(node.left, params);
  const op = node.negated ? "NOT IN" : "IN";
  const rhs = node.right;
  if (rhs.kind === "values") {
    if (rhs.values.length === 0) return node.negated ? "1=1" : "1=0";
    const placeholders = rhs.values.map((v) => {
      params.push(v);
      return dialect.placeholder(params.length);
    });
    return `${left} ${op} (${placeholders.join(", ")})`;
  }
  if (rhs.kind === "param") {
    params.push({ __param: rhs.name });
    return `${left} ${op} (${dialect.placeholder(params.length)})`;
  }
  // subquery
  return `${left} ${op} ${compileSubqueryPlan(rhs.plan, params, dialect)}`;
}

function compileExistsNode(
  node: Expr & { kind: "exists" },
  params: unknown[],
  dialect: DialectImpl,
  compileNode: CompileNodeFn,
): string {
  const innerSql = compileNode(node.predicate, params);
  const wrappedSql = node.negated ? `(NOT (${innerSql}))` : innerSql;
  const existsSql = dialect.compileExists(
    node.targetTable,
    node.innerAlias,
    node.fkColumns,
    node.outerAlias,
    node.mainPk,
    wrappedSql,
  );
  return node.negated ? `(NOT ${existsSql})` : existsSql;
}

export function makeCompileNode(dialect: DialectImpl) {
  function compileNode(node: Expr, params: unknown[]): string {
    switch (node.kind) {
      case "binary": {
        const left = compileNode(node.left, params);
        const right = compileNode(node.right, params);
        const op =
          node.op === "==" || node.op === "==="
            ? "="
            : node.op === "!=" || node.op === "!=="
              ? "<>"
              : node.op;
        if (node.op === "&&") return `(${left} AND ${right})`;
        if (node.op === "||") return `(${left} OR ${right})`;
        return `(${left} ${op} ${right})`;
      }
      case "unary":
        return `(NOT ${compileNode(node.operand, params)})`;
      case "column":
        return renderColumn(node);
      case "const":
        params.push(node.value);
        return dialect.placeholder(params.length);
      case "param":
        params.push({ __param: node.name });
        return dialect.placeholder(params.length);
      case "in":
        return compileInNode(node, params, dialect, compileNode);
      case "exists":
        return compileExistsNode(node, params, dialect, compileNode);
      case "subquery":
        return compileSubqueryPlan(node.plan, params, dialect);
      case "call": {
        const receiver = compileNode(node.receiver, params);
        if (
          node.method === "startsWith" ||
          node.method === "endsWith" ||
          node.method === "includes"
        ) {
          const arg = compileNode(node.args[0], params);
          return dialect.compileLike(receiver, arg, node.method);
        }
        throw new Error(`Unsupported method: ${node.method}`);
      }
      case "aggregate":
        return (
          dialect.compileAggregate?.(node, compileNode, params) ??
          compileAggregate(node, compileNode, params)
        );
      default:
        throw new Error(`Unknown Expr kind: ${(node as { kind: string }).kind}`);
    }
  }
  return compileNode;
}

export function compileWhereExpr(
  node: Expr | null,
  dialect: DialectImpl,
): { sql: string; params: unknown[] } {
  const compileNode = makeCompileNode(dialect);
  const params: unknown[] = [];
  const sql = node ? compileNode(node, params) : "1=1";
  return { sql, params };
}

export function compileOrderByExpr(
  orders: OrderItem[],
  dialect: DialectImpl,
): { sql: string; params: unknown[] } {
  if (orders.length === 0) return { sql: "", params: [] };
  const compileNode = makeCompileNode(dialect);
  const params: unknown[] = [];
  const sql = orders
    .map((o) => {
      const dir = o.direction === "desc" ? "DESC" : "ASC";
      return `${compileNode(o.expr, params)} ${dir}`;
    })
    .join(", ");
  return { sql, params };
}

export function compileSelectListExpr(
  items: SelectItem[],
  selectAll: boolean,
  tableAlias: string,
  columnNames: string[],
  dialect: DialectImpl,
  compileAggFn: (agg: ExprAggregate, compileNodeFn: CompileNodeFn, params: unknown[]) => string = (
    agg,
    fn,
    p,
  ) => compileAggregate(agg, fn, p),
): { sql: string; params: unknown[] } {
  const compileNode = makeCompileNode(dialect);
  const params: unknown[] = [];

  // Default "*" expansion: no items, no rest semantics needed — emit table cols.
  if (selectAll && items.length === 0) {
    return {
      sql: columnNames.map((c) => `${quoteId(tableAlias)}.${quoteId(c)}`).join(", "),
      params,
    };
  }

  const parts: string[] = [];
  for (const item of items) {
    const col =
      item.expr.kind === "aggregate"
        ? compileAggFn(item.expr, compileNode, params)
        : compileNode(item.expr, params);
    if (item.expr.kind === "aggregate") {
      // compileAggFn handles its own AS clause when agg.alias is set; if the
      // SelectItem provides an outer alias and the aggregate didn't, append.
      if (item.alias && !item.expr.alias) {
        parts.push(`${col} AS ${quoteId(item.alias)}`);
      } else {
        parts.push(col);
      }
    } else if (item.alias) {
      parts.push(`${col} AS ${quoteId(item.alias)}`);
    } else {
      parts.push(col);
    }
  }
  return { sql: parts.join(", "), params };
}

/** Top-level: build SQL for a QueryPlan. */
export function compilePlan(
  plan: QueryPlan,
  options: CompileQueryOpts = {},
  dialect: DialectImpl,
): CompileResult {
  const paramStartIndex = options.paramStartIndex ?? 1;
  let nextOffset = paramStartIndex;
  const expand = (
    compiled: { sql: string; params: unknown[] },
    paramValues: Record<string, unknown>,
  ): ExpandPlaceholdersResult => {
    const out = dialect.expandPlaceholders(
      compiled.sql,
      resolveParamSentinels(compiled.params, paramValues),
      nextOffset,
    );
    nextOffset += out.params.length;
    return out;
  };

  const joinsSql = plan.joins.map((j) => dialect.buildJoinClause(j, plan.tableAlias)).join("");

  switch (plan.operation.kind) {
    case "select": {
      const selectListExpanded = expand(
        compileSelectListExpr(
          plan.selectItems,
          plan.selectAll,
          plan.tableAlias,
          plan.columnNames,
          dialect,
          dialect.compileAggregate
            ? (agg, fn, p) => dialect.compileAggregate!(agg, fn, p)
            : undefined,
        ),
        plan.whereParams,
      );
      const whereExpanded = expand(compileWhereExpr(plan.where, dialect), plan.whereParams);
      const havingExpanded = plan.having
        ? expand(compileWhereExpr(plan.having, dialect), plan.havingParams)
        : null;
      const orderByExpanded = expand(compileOrderByExpr(plan.orderBy, dialect), plan.whereParams);
      const result = dialect.compileSelect({
        table: plan.tableName,
        tableAlias: plan.tableAlias,
        selectList: selectListExpanded.sql,
        selectListParams: selectListExpanded.params,
        whereSql: whereExpanded.sql,
        whereParams: whereExpanded.params,
        orderBySql: orderByExpanded.sql,
        orderByParams: orderByExpanded.params,
        limitNum: plan.limitNum,
        offsetNum: plan.offsetNum,
        joinsSql: joinsSql || undefined,
        groupBy: plan.groupBy.length > 0 ? plan.groupBy : undefined,
        havingSql: havingExpanded?.sql,
        havingParams: havingExpanded?.params,
        paramStartIndex,
      });
      return options.wrap ? { sql: `(${result.sql})`, params: result.params } : result;
    }
    case "count": {
      const whereExpanded = expand(compileWhereExpr(plan.where, dialect), plan.whereParams);
      return dialect.compileCount(
        plan.tableName,
        plan.tableAlias,
        whereExpanded.sql,
        whereExpanded.params,
        joinsSql || undefined,
      );
    }
    case "update": {
      const whereExpanded = expand(compileWhereExpr(plan.where, dialect), plan.whereParams);
      return dialect.compileUpdate(
        plan.tableName,
        plan.operation.set,
        plan.columnNames,
        whereExpanded.sql,
        whereExpanded.params,
        { returning: plan.operation.returning },
      );
    }
    case "delete": {
      const whereExpanded = expand(compileWhereExpr(plan.where, dialect), plan.whereParams);
      return dialect.compileDelete(plan.tableName, whereExpanded.sql, whereExpanded.params, {
        returning: plan.operation.returning,
      });
    }
  }
}
