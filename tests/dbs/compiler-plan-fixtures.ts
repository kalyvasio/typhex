import type { OnConflictClause, QueryOperation } from "../../src/dbs/types.js";
import type { Expr, GroupByItem, JoinSpec, OrderItem, SelectItem } from "../../src/orm/expr.js";
import type { QueryPlan } from "../../src/orm/helpers/query-plan/query-plan.js";

function basePlan(
  table: string,
  operation: QueryOperation,
  overrides: Partial<QueryPlan> = {},
): QueryPlan {
  return {
    operation,
    tableName: table,
    tableAlias: "t0",
    columnNames: [],
    where: null,
    having: null,
    orderBy: [],
    groupBy: [],
    limitNum: null,
    offsetNum: null,
    selectItems: [],
    selectAll: false,
    joins: [],
    relationFetches: [],
    joinedProjections: [],
    skipLoadFor: new Set(),
    whereParams: {},
    havingParams: {},
    pkColumns: [],
    referencedRegisteredCtes: [],
    ...overrides,
  };
}

export function insertPlan(
  table: string,
  columns: string[],
  values: unknown[],
  pk?: string[],
  onConflict?: OnConflictClause,
): QueryPlan {
  return basePlan(
    table,
    { kind: "insert", columns, values, pk, onConflict },
    { columnNames: columns },
  );
}

export function insertManyPlan(
  table: string,
  columns: string[],
  rows: unknown[][],
  pk?: string[],
  onConflict?: OnConflictClause,
): QueryPlan {
  return basePlan(
    table,
    { kind: "insertMany", columns, rows, pk, onConflict },
    { columnNames: columns },
  );
}

export function updatePlan(
  table: string,
  columnNames: string[],
  set: Record<string, unknown>,
  where: Expr,
  returning?: boolean,
): QueryPlan {
  const updateSet: Record<string, Expr> = {};
  for (const [key, value] of Object.entries(set)) {
    updateSet[key] = { kind: "const", value };
  }
  return basePlan(table, { kind: "update", set, returning }, { columnNames, where, updateSet });
}

export function deletePlan(table: string, where: Expr, returning?: boolean): QueryPlan {
  return basePlan(table, { kind: "delete", returning }, { where });
}

export function resultSizePlan(table: string, where: Expr, joins: JoinSpec[] = []): QueryPlan {
  return basePlan(table, { kind: "select" }, { where, joins });
}

export function selectPlan(
  table: string,
  opts: {
    columnNames?: string[];
    selectItems?: SelectItem[];
    selectAll?: boolean;
    where?: Expr | null;
    whereParams?: Record<string, unknown>;
    having?: Expr | null;
    havingParams?: Record<string, unknown>;
    orderBy?: OrderItem[];
    groupBy?: GroupByItem[];
    limitNum?: number | null;
    offsetNum?: number | null;
    joins?: JoinSpec[];
  } = {},
): QueryPlan {
  return basePlan(
    table,
    { kind: "select" },
    {
      columnNames: opts.columnNames ?? [],
      selectItems: opts.selectItems ?? [],
      selectAll: opts.selectAll ?? false,
      where: opts.where ?? null,
      whereParams: opts.whereParams ?? {},
      having: opts.having ?? null,
      havingParams: opts.havingParams ?? {},
      orderBy: opts.orderBy ?? [],
      groupBy: opts.groupBy ?? [],
      limitNum: opts.limitNum ?? null,
      offsetNum: opts.offsetNum ?? null,
      joins: opts.joins ?? [],
    },
  );
}
