import type { IrNode, IrOrderBy, IrSelect } from "../../src/ir/types.js";
import type { SelectItem } from "../../src/orm/expr.js";
import { ExprBuilder } from "../../src/orm/helpers/query-plan/expr-builder.js";
import { selectPlan } from "../dbs/compiler-plan-fixtures.js";
import { sqliteQueryCompiler, postgresQueryCompiler } from "../../src/dbs/index.js";
import type { BaseQueryCompiler } from "../../src/dbs/query-compiler.js";

const TEST_TABLE = "__ir_test";

function exprBuilderFor(param = "u", alias = "t0"): ExprBuilder {
  return new ExprBuilder({ [param]: alias }, {}, {}, new Map());
}

export function compileIrWhere(
  ir: IrNode,
  compiler: BaseQueryCompiler = sqliteQueryCompiler,
  param = "u",
  alias = "t0",
) {
  const expr = exprBuilderFor(param, alias).convert(ir);
  return compiler.compileWhereExpr(expr);
}

export function compileIrSelectList(
  select: IrSelect,
  columnNames: string[],
  compiler: BaseQueryCompiler = sqliteQueryCompiler,
  param = select.param,
  alias = "t0",
): string {
  const exprBuilder = exprBuilderFor(param, alias);
  const items: SelectItem[] = [];

  for (let i = 0; i < select.paths.length; i++) {
    const path = select.paths[i];
    items.push({
      expr: exprBuilder.resolveColumn(param, path),
      alias: select.aliases?.[i],
    });
  }
  for (const agg of select.aggregates ?? []) {
    items.push({ expr: exprBuilder.convertAggregate(agg), alias: agg.alias });
  }
  for (const entry of select.expressions ?? []) {
    items.push({ expr: exprBuilder.convert(entry.expr), alias: entry.alias });
  }

  const plan = selectPlan(TEST_TABLE, { columnNames, selectItems: items });
  return selectListFrom(compiler.compilePlan(plan).sql);
}

export function compileIrOrderBy(
  orders: IrOrderBy[],
  compiler: BaseQueryCompiler = sqliteQueryCompiler,
  param = "u",
  alias = "t0",
): string {
  const exprBuilder = exprBuilderFor(param, alias);
  const orderItems = orders.map((o) => ({
    expr:
      o.expr.kind === "member"
        ? exprBuilder.resolveColumn(o.expr.param, o.expr.path)
        : exprBuilder.convert(o.expr),
    direction: o.direction,
  }));
  const plan = selectPlan(TEST_TABLE, {
    columnNames: ["id"],
    selectAll: true,
    orderBy: orderItems,
  });
  return orderByFrom(compiler.compilePlan(plan).sql);
}

export { sqliteQueryCompiler, postgresQueryCompiler };

function selectListFrom(sql: string): string {
  const prefix = "SELECT ";
  const from = ` FROM "${TEST_TABLE}"`;
  return sql.slice(prefix.length, sql.indexOf(from));
}

function orderByFrom(sql: string): string {
  return sql.slice(sql.indexOf(" ORDER BY ") + " ORDER BY ".length);
}
