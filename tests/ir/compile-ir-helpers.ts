import type { IrNode, IrOrderBy, IrSelect } from "../../src/ir/types.js";
import type { SelectItem } from "../../src/orm/expr.js";
import { ExprBuilder } from "../../src/orm/helpers/query-plan/expr-builder.js";
import {
  sqliteQueryCompiler,
  postgresQueryCompiler,
} from "../../src/dbs/index.js";
import type { BaseQueryCompiler } from "../../src/dbs/query-compiler.js";

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

  return compiler.compileSelectListExpr(items, false, alias, columnNames).sql;
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
  return compiler.compileOrderByExpr(orderItems).sql;
}

export { sqliteQueryCompiler, postgresQueryCompiler };
