/**
 * Serialize IR structures into TypeScript object-literal expression nodes so
 * the transformer can emit pre-built IR as the first argument of rewritten calls.
 */

import ts from "typescript";
import type { IrNode, IrSelect, IrWhere, IrOrderBy, IrAggregate } from "../ir/types.js";

function valueToTsExpression(value: unknown, f: ts.NodeFactory): ts.Expression {
  if (value === null) return f.createNull();
  switch (typeof value) {
    case "string":
      return f.createStringLiteral(value);
    case "number":
      return f.createNumericLiteral(value);
    case "boolean":
      return value ? f.createTrue() : f.createFalse();
  }
  if (Array.isArray(value)) {
    return f.createArrayLiteralExpression(
      (value as unknown[]).map((v) => valueToTsExpression(v, f)),
    );
  }
  return f.createStringLiteral(JSON.stringify(value) ?? String(value));
}

function stringArrayLiteral(items: string[], f: ts.NodeFactory): ts.ArrayLiteralExpression {
  return f.createArrayLiteralExpression(items.map((p) => f.createStringLiteral(p)));
}

export function irNodeToTsLiteral(ir: IrNode): ts.ObjectLiteralExpression {
  const f = ts.factory;

  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("kind", f.createStringLiteral(ir.kind)),
  ];

  switch (ir.kind) {
    case "aggregate":
      return irAggregateToTsLiteral(ir);
    case "binary":
      props.push(
        f.createPropertyAssignment("op", f.createStringLiteral(ir.op)),
        f.createPropertyAssignment("left", irNodeToTsLiteral(ir.left)),
        f.createPropertyAssignment("right", irNodeToTsLiteral(ir.right)),
      );
      break;
    case "unary":
      props.push(
        f.createPropertyAssignment("op", f.createStringLiteral(ir.op)),
        f.createPropertyAssignment("operand", irNodeToTsLiteral(ir.operand)),
      );
      break;
    case "member":
      props.push(
        f.createPropertyAssignment("param", f.createStringLiteral(ir.param)),
        f.createPropertyAssignment("path", stringArrayLiteral(ir.path, f)),
      );
      break;
    case "const":
      props.push(f.createPropertyAssignment("value", valueToTsExpression(ir.value, f)));
      break;
    case "param":
      props.push(f.createPropertyAssignment("key", f.createStringLiteral(ir.key)));
      break;
    case "in":
      props.push(
        f.createPropertyAssignment("left", irNodeToTsLiteral(ir.left)),
        f.createPropertyAssignment("right", irNodeToTsLiteral(ir.right)),
      );
      if (ir.negated) props.push(f.createPropertyAssignment("negated", f.createTrue()));
      break;
    case "call":
      props.push(
        f.createPropertyAssignment("method", f.createStringLiteral(ir.method)),
        f.createPropertyAssignment("receiver", irNodeToTsLiteral(ir.receiver)),
        f.createPropertyAssignment(
          "args",
          f.createArrayLiteralExpression(ir.args.map((a) => irNodeToTsLiteral(a))),
        ),
      );
      break;
    case "exists":
      props.push(
        f.createPropertyAssignment("rootParam", f.createStringLiteral(ir.rootParam)),
        f.createPropertyAssignment("relationKey", f.createStringLiteral(ir.relationKey)),
        f.createPropertyAssignment("innerParam", f.createStringLiteral(ir.innerParam)),
        f.createPropertyAssignment("innerWhere", irNodeToTsLiteral(ir.innerWhere)),
      );
      if (ir.negated) props.push(f.createPropertyAssignment("negated", f.createTrue()));
      break;
    case "subqueryRef":
      props.push(f.createPropertyAssignment("key", f.createStringLiteral(ir.key)));
      break;
  }
  return f.createObjectLiteralExpression(props);
}

export function irWhereToTsLiteral(where: IrWhere): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("node", irNodeToTsLiteral(where.node)),
    f.createPropertyAssignment("rootParam", f.createStringLiteral(where.rootParam)),
  ];
  if (where.localParamNames && where.localParamNames.length > 0) {
    props.push(
      f.createPropertyAssignment("localParamNames", stringArrayLiteral(where.localParamNames, f)),
    );
  }
  return f.createObjectLiteralExpression(props);
}

export function irOrderByToTsLiteral(ir: IrOrderBy): ts.ObjectLiteralExpression {
  const f = ts.factory;
  return f.createObjectLiteralExpression([
    f.createPropertyAssignment("expr", irNodeToTsLiteral(ir.expr)),
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
  if (agg.separator !== undefined)
    props.push(f.createPropertyAssignment("separator", f.createStringLiteral(agg.separator)));
  return f.createObjectLiteralExpression(props);
}

export function irSelectToTsLiteral(sel: IrSelect): ts.ObjectLiteralExpression {
  const f = ts.factory;
  const props: ts.ObjectLiteralElementLike[] = [
    f.createPropertyAssignment("param", f.createStringLiteral(sel.param)),
    f.createPropertyAssignment(
      "paths",
      f.createArrayLiteralExpression(sel.paths.map((path) => stringArrayLiteral(path, f))),
    ),
  ];

  if (sel.aliases && sel.aliases.length > 0) {
    props.push(f.createPropertyAssignment("aliases", stringArrayLiteral(sel.aliases, f)));
  }
  if (sel.rest) {
    props.push(f.createPropertyAssignment("rest", f.createTrue()));
  }
  if (sel.aggregates && sel.aggregates.length > 0) {
    props.push(
      f.createPropertyAssignment(
        "aggregates",
        f.createArrayLiteralExpression(sel.aggregates.map(irAggregateToTsLiteral)),
      ),
    );
  }
  if (sel.groupBy && sel.groupBy.length > 0) {
    props.push(f.createPropertyAssignment("groupBy", groupByToTsLiteral(sel.groupBy, f)));
  }
  if (sel.subqueries && sel.subqueries.length > 0) {
    props.push(
      f.createPropertyAssignment(
        "subqueries",
        f.createArrayLiteralExpression(
          sel.subqueries.map((entry) =>
            f.createObjectLiteralExpression([
              f.createPropertyAssignment("alias", f.createStringLiteral(entry.alias)),
              f.createPropertyAssignment("subquery", irNodeToTsLiteral(entry.subquery)),
            ]),
          ),
        ),
      ),
    );
  }
  return f.createObjectLiteralExpression(props);
}

function groupByToTsLiteral(
  groupBy: Array<string[] | number>,
  f: ts.NodeFactory,
): ts.ArrayLiteralExpression {
  return f.createArrayLiteralExpression(
    groupBy.map((entry) =>
      typeof entry === "number" ? f.createNumericLiteral(entry) : stringArrayLiteral(entry, f),
    ),
  );
}
