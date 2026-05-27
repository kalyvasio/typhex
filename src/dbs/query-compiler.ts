/**
 * Shared SQL query compiler.
 *
 * The public surface compiles complete query/migration operations. Dialect
 * subclasses override protected pieces where SQL differs.
 */

import type {
  ColumnDef,
  CompileQueryOpts,
  CompileResult,
  CompileSelectOpts,
  DiffAction,
  ExpandPlaceholdersResult,
  OnConflictClause,
  QueryCompiler,
  CompiledCteBody,
} from "./types.js";
import { getColumnDef, resolveParamSentinels, SQL_DEFAULT } from "./types.js";
import type {
  Expr,
  ExprAggregate,
  ExprColumn,
  GroupByItem,
  JoinSpec,
  OrderItem,
  SelectItem,
} from "../orm/expr.js";
import type { QueryPlan } from "../orm/helpers/query-plan/query-plan.js";
import { QueryPlanBuilder } from "../orm/helpers/query-plan/query-plan.js";
import type { FromSource, QueryState } from "../orm/query-state.js";
import type { DialectName, WithClause } from "./types.js";
import type { JoinType } from "../ir/types.js";

type AlterColumnAction = Extract<DiffAction, { kind: "alter_column" }>;

type PreparedReadPlan = {
  compiledCteBodies: CompiledCteBody[];
  fromResolved: { fromClause: string; fromParams: unknown[] };
  joinsSql: string;
  joinParams: unknown[];
  expand: (
    compiled: { sql: string; params: unknown[] },
    paramValues: Record<string, unknown>,
  ) => ExpandPlaceholdersResult;
  paramStartIndex: number;
};

function wrapUnionAllBranchSql(
  sql: string,
  plan: Pick<QueryPlan, "orderBy" | "limitNum" | "offsetNum">,
): string {
  const needsParens = plan.orderBy.length > 0 || plan.limitNum != null || plan.offsetNum != null; 
  return needsParens ? `(${sql})` : sql;
}

export abstract class BaseQueryCompiler implements QueryCompiler {
  protected static readonly JOIN_SQL_KEYWORDS: Record<JoinType, string> = {
    inner: "INNER JOIN",
    left: "LEFT JOIN",
    right: "RIGHT JOIN",
    cross: "CROSS JOIN",
    full: "FULL OUTER JOIN",
  };

  protected abstract readonly dialect: DialectName;

  protected renderColumn(col: ExprColumn): string {
    if (col.column.length === 0) return this.escapeIdentifier(col.alias);
    return `${this.escapeIdentifier(col.alias)}.${col.column.map((c) => this.escapeIdentifier(c)).join(".")}`;
  }

  protected compileAggregateArg(arg: Expr | null, params: unknown[]): string {
    if (arg === null) return "*";
    if (arg.kind === "column") return this.renderColumn(arg);
    if (arg.kind === "const" && typeof arg.value === "number") {
      return String(arg.value);
    }
    return this.compileNode(arg, params);
  }

  protected compileStandardAggregate(
    funcName: string,
    agg: ExprAggregate,
    params: unknown[],
  ): string {
    const argSql = this.compileAggregateArg(agg.arg, params);
    const distinctPrefix = agg.distinct ? "DISTINCT " : "";
    const expr = `${funcName}(${distinctPrefix}${argSql})`;
    return agg.alias ? `${expr} AS ${this.escapeIdentifier(agg.alias)}` : expr;
  }

  protected compileConcatAggregate(
    funcName: string,
    agg: ExprAggregate,
    defaultSep: string | undefined,
    params: unknown[],
  ): string {
    const argSql = this.compileAggregateArg(agg.arg, params);
    const distinctPrefix = agg.distinct ? "DISTINCT " : "";
    const sepLiteral =
      agg.separator !== undefined ? `'${agg.separator.replaceAll("'", "''")}'` : defaultSep;
    const inner =
      sepLiteral !== undefined
        ? `${distinctPrefix}${argSql}, ${sepLiteral}`
        : `${distinctPrefix}${argSql}`;
    const expr = `${funcName}(${inner})`;
    return agg.alias ? `${expr} AS ${this.escapeIdentifier(agg.alias)}` : expr;
  }

  compileGroupBy(items: GroupByItem[]): string {
    return items
      .map((entry) => {
        if (entry.kind === "index") return String(entry.index);
        return this.renderColumn(entry);
      })
      .join(", ");
  }

  compilePlan(plan: QueryPlan, options: CompileQueryOpts = {}): CompileResult {
    const operation = plan.operation;
    switch (operation.kind) {
      case "select":
        return this.compileSelectPlan(plan, options);
      case "insert":
        return this.compileInsert(
          plan.tableName,
          operation.columns,
          operation.values,
          operation.pk,
          operation.onConflict,
        );
      case "insertMany":
        return this.compileInsertMany(
          plan.tableName,
          operation.columns,
          operation.rows,
          operation.pk,
          operation.onConflict,
        );
      case "update":
        return this.compileUpdatePlan(plan);
      case "delete":
        return this.compileDeletePlan(plan);
    }
  }

  compileResultSize(plan: QueryPlan): CompileResult {
    const inner = this.compileSelectPlan(
      { ...plan, orderBy: [], limitNum: null, offsetNum: null },
      { wrap: true },
    );
    return {
      sql: `SELECT COUNT(*) AS c FROM ${inner.sql} AS ${this.escapeIdentifier("_count")}`,
      params: inner.params,
    };
  }

  protected compileCteBodies(
    ctes: WithClause[] | undefined,
    allowedCteNames: string[] = [],
  ): CompiledCteBody[] {
    if (!ctes?.length) return [];

    const bodies: CompiledCteBody[] = [];

    for (const clause of ctes) {
      const innerState = clause.inner as QueryState<unknown>;
      const innerPlan = QueryPlanBuilder.build(innerState, { kind: "select" });
      const priorNames = [...allowedCteNames, ...bodies.map((c) => c.name)];
      const allowedForInner =
        clause.kind === "recursive" ? [...priorNames, clause.name] : priorNames;
      const body = this.compilePlan(innerPlan, {
        paramStartIndex: 1,
        allowedCteNames: allowedForInner,
      });
      bodies.push({
        name: clause.name,
        bodySql: body.sql,
        bodyParams: body.params,
        recursive: clause.kind === "recursive",
      });
    }

    return bodies;
  }

  protected resolvePlanFromClause(
    plan: {
      tableName: string;
      tableAlias: string;
      fromSource?: FromSource;
    },
    allowedCteNames: string[],
    paramStartIndex: number,
    compileOptions: CompileQueryOpts = {},
  ): { fromClause: string; fromParams: unknown[] } {
    const source = plan.fromSource ?? { kind: "table" as const };
    const alias = this.escapeIdentifier(plan.tableAlias);

    switch (source.kind) {
      case "table":
        return {
          fromClause: `${this.escapeIdentifier(plan.tableName)} AS ${alias}`,
          fromParams: [],
        };
      case "cte":
        return {
          fromClause: `${this.escapeIdentifier(source.name)} AS ${alias}`,
          fromParams: [],
        };
      case "subquery": {
        const innerPlan = QueryPlanBuilder.build(source.state, { kind: "select" });
        const compiled = this.compilePlan(innerPlan, {
          wrap: true,
          paramStartIndex,
          allowedCteNames: compileOptions.allowedCteNames,
        });
        return {
          fromClause: `${compiled.sql} AS ${alias}`,
          fromParams: compiled.params,
        };
      }
    }
  }

  protected prepareReadPlan(plan: QueryPlan, options: CompileQueryOpts): PreparedReadPlan {
    const compiledCteBodies = options.skipCteRender
      ? []
      : this.compileCteBodies(plan.ctes, options.allowedCteNames);
    const allowedCteNames = [
      ...(options.allowedCteNames ?? []),
      ...compiledCteBodies.map((c) => c.name),
    ];

    const fromResolved = this.resolvePlanFromClause(
      plan,
      allowedCteNames,
      options.paramStartIndex ?? 1,
      options,
    );
    const { expand, paramStartIndex } = this.createExpander({
      ...options,
      paramStartIndex: (options.paramStartIndex ?? 1) + fromResolved.fromParams.length,
    });
    const joinsExpanded = this.compileJoinsSql(plan, expand);

    return {
      compiledCteBodies,
      fromResolved,
      joinsSql: joinsExpanded.sql,
      joinParams: joinsExpanded.params,
      expand,
      paramStartIndex,
    };
  }

  private compileJoinsSql(
    plan: QueryPlan,
    expand: ReturnType<BaseQueryCompiler["createExpander"]>["expand"],
  ): { sql: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const join of plan.joins) {
      if (join.on) {
        const onExpanded = expand(this.compileWhereExpr(join.on), plan.whereParams);
        params.push(...onExpanded.params);
        parts.push(this.buildJoinClause(join, plan.tableAlias, onExpanded.sql));
      } else {
        parts.push(this.buildJoinClause(join, plan.tableAlias));
      }
    }
    return { sql: parts.join(""), params };
  }

  protected abstract compileWithClause(
    coreSql: string,
    coreParams: unknown[],
    bodies: CompiledCteBody[],
    paramStartIndex: number,
  ): CompileResult;

  protected attachCteBodies(
    core: CompileResult,
    bodies: CompiledCteBody[],
    paramStartIndex: number,
  ): CompileResult {
    if (!bodies.length) return core;
    return this.compileWithClause(core.sql, core.params, bodies, paramStartIndex);
  }

  compileMigrationUp(action: DiffAction): string {
    switch (action.kind) {
      case "add_table":
        return this.compileCreateTable(action.table, action.schema, false);
      case "drop_table":
        return `DROP TABLE IF EXISTS ${this.escapeIdentifier(action.table)};`;
      case "add_column":
        return `ALTER TABLE ${this.escapeIdentifier(action.table)} ADD COLUMN ${this.escapeIdentifier(action.column)} ${this.toColumnDef(action.definition)};`;
      case "drop_column":
        return `ALTER TABLE ${this.escapeIdentifier(action.table)} DROP COLUMN ${this.escapeIdentifier(action.column)};`;
      case "alter_column":
        return this.compileAlterColumn(action, false);
    }
  }

  compileMigrationDown(action: DiffAction): string {
    switch (action.kind) {
      case "add_table":
        return `DROP TABLE IF EXISTS ${this.escapeIdentifier(action.table)};`;
      case "drop_table":
        return this.compileRecreateDroppedTable(action.table, action.columnInfos);
      case "add_column":
        return `ALTER TABLE ${this.escapeIdentifier(action.table)} DROP COLUMN ${this.escapeIdentifier(action.column)};`;
      case "drop_column":
        return `ALTER TABLE ${this.escapeIdentifier(action.table)} ADD COLUMN ${this.escapeIdentifier(action.column)} ${this.reconstructColDef(action.columnInfo)};`;
      case "alter_column":
        return this.compileAlterColumn(action, true);
    }
  }

  compileCreateTableIfNotExists(table: string, schema: Record<string, ColumnDef>): string {
    return this.compileCreateTable(table, schema, true);
  }

  compileAppliedMigrations(): CompileResult {
    const id = this.escapeIdentifier("id");
    const name = this.escapeIdentifier("name");
    const appliedAt = this.escapeIdentifier("applied_at");
    const table = this.escapeIdentifier("_typhex_migrations");
    return {
      sql: `SELECT ${id}, ${name}, ${appliedAt} FROM ${table} ORDER BY ${id}`,
      params: [],
    };
  }

  compileRecordMigration(name: string): CompileResult {
    return {
      sql: `INSERT INTO ${this.escapeIdentifier("_typhex_migrations")} (${this.escapeIdentifier("name")}) VALUES (${this.placeholder(1)})`,
      params: [name],
    };
  }

  compileDeleteMigration(name: string): CompileResult {
    return {
      sql: `DELETE FROM ${this.escapeIdentifier("_typhex_migrations")} WHERE ${this.escapeIdentifier("name")} = ${this.placeholder(1)}`,
      params: [name],
    };
  }

  compileNextSequenceValues(_tableName: string, _pkColumn: string, _count: number): CompileResult {
    throw new Error(`${this.dialect} sequence allocation is not configured for this dialect`);
  }

  abstract compileTrackingTable(): CompileResult;
  abstract compileListTables(): CompileResult;
  abstract compileListColumns(table: string): CompileResult;

  /** @internal */
  compileWhereExpr(node: Expr | null): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const sql = node ? this.compileNode(node, params) : "1=1";
    return { sql, params };
  }

  /** @internal */
  compileOrderByExpr(orders: OrderItem[]): { sql: string; params: unknown[] } {
    if (orders.length === 0) return { sql: "", params: [] };
    const params: unknown[] = [];
    const sql = orders
      .map((o) => {
        const dir = o.direction === "desc" ? "DESC" : "ASC";
        return `${this.compileNode(o.expr, params)} ${dir}`;
      })
      .join(", ");
    return { sql, params };
  }

  /** @internal */
  compileSelectListExpr(
    items: SelectItem[],
    selectAll: boolean,
    tableAlias: string,
    columnNames: string[],
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    if (selectAll && items.length === 0) {
      return {
        sql: columnNames
          .map((c) => `${this.escapeIdentifier(tableAlias)}.${this.escapeIdentifier(c)}`)
          .join(", "),
        params,
      };
    }

    const parts: string[] = [];
    for (const item of items) {
      const col =
        item.expr.kind === "aggregate"
          ? this.compileAggregate(item.expr, params)
          : this.compileNode(item.expr, params);
      if (item.expr.kind === "aggregate") {
        if (item.alias && !item.expr.alias) {
          parts.push(`${col} AS ${this.escapeIdentifier(item.alias)}`);
        } else {
          parts.push(col);
        }
      } else if (item.alias) {
        parts.push(`${col} AS ${this.escapeIdentifier(item.alias)}`);
      } else {
        parts.push(col);
      }
    }
    return { sql: parts.join(", "), params };
  }

  protected escapeIdentifier(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
  }

  protected placeholder(index: number): string {
    return this.dialect === "postgres" ? `$${index}` : "?";
  }

  protected abstract expandPlaceholders(
    sql: string,
    resolvedParams: unknown[],
    startIdx?: number,
  ): ExpandPlaceholdersResult;

  protected toColumnDef(def: ColumnDef): string {
    return getColumnDef(def, this.dialect);
  }

  protected compileSelectPlan(plan: QueryPlan, options: CompileQueryOpts): CompileResult {
    const prepared = this.prepareReadPlan(plan, options);
    const selectListExpanded = prepared.expand(
      this.compileSelectListExpr(
        plan.selectItems,
        plan.selectAll,
        plan.tableAlias,
        plan.columnNames,
      ),
      plan.whereParams,
    );
    const whereExpanded = prepared.expand(this.compileWhereExpr(plan.where), plan.whereParams);
    const havingExpanded = plan.having
      ? prepared.expand(this.compileWhereExpr(plan.having), plan.havingParams)
      : null;
    const orderByExpanded = prepared.expand(this.compileOrderByExpr(plan.orderBy), plan.whereParams);
    let result = this.compileSelect({
      table: plan.tableName,
      tableAlias: plan.tableAlias,
      fromClause: prepared.fromResolved.fromClause,
      fromParams: prepared.fromResolved.fromParams,
      joinParams: prepared.joinParams,
      selectList: selectListExpanded.sql,
      selectListParams: selectListExpanded.params,
      whereSql: whereExpanded.sql,
      whereParams: whereExpanded.params,
      orderBySql: orderByExpanded.sql,
      orderByParams: orderByExpanded.params,
      limitNum: plan.limitNum,
      offsetNum: plan.offsetNum,
      joinsSql: prepared.joinsSql || undefined,
      groupBy: plan.groupBy.length > 0 ? plan.groupBy : undefined,
      havingSql: havingExpanded?.sql,
      havingParams: havingExpanded?.params,
      paramStartIndex: prepared.paramStartIndex,
    });

    if (plan.unionAll) {
      const unionStart = (options.paramStartIndex ?? 1) + result.params.length;
      const unionCompiled = this.compileSelectPlan(plan.unionAll, {
        ...options,
        skipCteRender: true,
        wrap: false,
        paramStartIndex: unionStart,
      });
      const left = wrapUnionAllBranchSql(result.sql, plan);
      const right = wrapUnionAllBranchSql(unionCompiled.sql, plan.unionAll);
      result = {
        sql: `${left} UNION ALL ${right}`,
        params: [...result.params, ...unionCompiled.params],
      };
    }

    const wrapped = options.skipCteRender
      ? result
      : this.attachCteBodies(
          result,
          prepared.compiledCteBodies,
          options.paramStartIndex ?? 1,
        );
    return options.wrap ? { sql: `(${wrapped.sql})`, params: wrapped.params } : wrapped;
  }

  protected compileUpdatePlan(plan: QueryPlan): CompileResult {
    if (plan.operation.kind !== "update") {
      throw new Error("compileUpdatePlan expects an update operation");
    }
    const registered = this.registeredCteNames(plan);
    const referenced = this.collectMutationCteRefs(plan, registered);
    const fromCtes = this.orderedReferencedCtes(plan, referenced);
    const bodies = referenced.size > 0 ? this.compileCteBodies(plan.ctes) : [];

    const { expand } = this.createExpander({});
    const whereExpanded = expand(this.compileWhereExpr(plan.where), plan.whereParams);
    const result = this.compileUpdate(
      plan.tableName,
      plan.updateSet ?? {},
      plan.columnNames,
      whereExpanded.sql,
      whereExpanded.params,
      {
        returning: plan.operation.returning,
        fromCtes,
        tableAlias: plan.tableAlias,
        registeredCteNames: registered,
      },
    );
    return referenced.size > 0 ? this.attachCteBodies(result, bodies, 1) : result;
  }

  protected compileDeletePlan(plan: QueryPlan): CompileResult {
    if (plan.operation.kind !== "delete") {
      throw new Error("compileDeletePlan expects a delete operation");
    }
    const registered = this.registeredCteNames(plan);
    const referenced = this.collectReferencedCteNames(plan.where, registered);
    const fromCtes = this.orderedReferencedCtes(plan, referenced);
    const bodies = referenced.size > 0 ? this.compileCteBodies(plan.ctes) : [];

    const { expand } = this.createExpander({});
    const whereExpanded = expand(this.compileWhereExpr(plan.where), plan.whereParams);
    const result = this.compileDelete(plan.tableName, whereExpanded.sql, whereExpanded.params, {
      returning: plan.operation.returning,
      fromCtes,
      tableAlias: plan.tableAlias,
    });
    return referenced.size > 0 ? this.attachCteBodies(result, bodies, 1) : result;
  }

  protected compileSelect(opts: CompileSelectOpts): CompileResult {
    const params = [
      ...(opts.fromParams ?? []),
      ...(opts.joinParams ?? []),
      ...(opts.selectListParams ?? []),
      ...opts.whereParams,
    ];
    const groupByClause =
      opts.groupBy && opts.groupBy.length > 0 ? ` GROUP BY ${this.compileGroupBy(opts.groupBy)}` : "";
    let havingClause = "";
    if (opts.havingSql) {
      havingClause = ` HAVING ${opts.havingSql}`;
      params.push(...(opts.havingParams ?? []));
    }
    if (opts.orderByParams && opts.orderByParams.length > 0) {
      params.push(...opts.orderByParams);
    }
    const fromParamCount = opts.fromParams?.length ?? 0;
    let paramIdx = (opts.paramStartIndex ?? 1) + params.length - fromParamCount;
    const nextPlaceholder = () => this.placeholder(paramIdx++);
    const limitClause = opts.limitNum != null ? ` LIMIT ${nextPlaceholder()}` : "";
    if (opts.limitNum != null) params.push(opts.limitNum);
    const offsetClause = opts.offsetNum != null ? ` OFFSET ${nextPlaceholder()}` : "";
    if (opts.offsetNum != null) params.push(opts.offsetNum);
    const orderClause = opts.orderBySql ? ` ORDER BY ${opts.orderBySql}` : "";
    const fromPart =
      opts.fromClause ??
      `${this.escapeIdentifier(opts.table)} AS ${this.escapeIdentifier(opts.tableAlias)}`;
    return {
      sql: `SELECT ${opts.selectList} FROM ${fromPart}${opts.joinsSql ?? ""} WHERE ${opts.whereSql}${groupByClause}${havingClause}${orderClause}${limitClause}${offsetClause}`,
      params,
    };
  }

  protected compileInsert(
    table: string,
    columns: string[],
    values: unknown[],
    pk?: string[],
    onConflict?: OnConflictClause,
  ): CompileResult {
    const hasPk = !!pk?.length;
    if (columns.length === 0) {
      if (onConflict) {
        throw new Error(
          "insert: ON CONFLICT requires explicit columns (empty INSERT not supported with onConflict)",
        );
      }
      const returning = this.singleInsertReturnsRows(hasPk);
      return {
        sql: `INSERT INTO ${this.escapeIdentifier(table)} DEFAULT VALUES${returning ? " RETURNING *" : ""}`,
        params: [],
        returningRow: returning,
      };
    }
    const placeholders = columns.map((_, i) => this.placeholder(i + 1)).join(", ");
    let sql = `INSERT INTO ${this.escapeIdentifier(table)} (${columns.map((c) => this.escapeIdentifier(c)).join(", ")}) VALUES (${placeholders})`;
    if (onConflict) sql = this.appendOnConflict(sql, onConflict, columns);
    const returning = this.singleInsertReturnsRows(hasPk);
    if (returning) sql += " RETURNING *";
    return { sql, params: values, returningRow: returning };
  }

  protected compileInsertMany(
    table: string,
    columns: string[],
    rows: unknown[][],
    pk?: string[],
    onConflict?: OnConflictClause,
  ): CompileResult {
    if (rows.length === 0 || columns.length === 0) {
      return { sql: "", params: [], returningRow: false };
    }
    let paramIdx = 1;
    const params: unknown[] = [];
    const rowPlaceholders = rows.map((row) => {
      const placeholders = row.map((value) => {
        const rendered = this.renderInsertManyValue(value, paramIdx);
        if (rendered.params.length > 0) {
          params.push(...rendered.params);
          paramIdx += rendered.params.length;
        }
        return rendered.sql;
      });
      return `(${placeholders.join(", ")})`;
    });
    let sql = `INSERT INTO ${this.escapeIdentifier(table)} (${columns.map((c) => this.escapeIdentifier(c)).join(", ")}) VALUES ${rowPlaceholders.join(", ")}`;
    if (onConflict) sql = this.appendOnConflict(sql, onConflict, columns);
    const returning = !!pk?.length;
    if (returning) sql += " RETURNING *";
    return { sql, params, returningRow: returning };
  }

  protected compileUpdate(
    table: string,
    updateSet: Record<string, Expr>,
    columns: string[],
    whereSql: string,
    whereParams: unknown[],
    options?: {
      returning?: boolean;
      fromCtes?: string[];
      tableAlias?: string;
      registeredCteNames?: Set<string>;
    },
  ): CompileResult {
    const cols = Object.keys(updateSet).filter((k) => columns.includes(k));
    if (cols.length === 0) return { sql: "", params: [] };
    const cteNames = options?.registeredCteNames ?? new Set<string>();
    const fromCtes = options?.fromCtes ?? [];
    const useFrom = fromCtes.length > 0;
    const alias = options?.tableAlias ?? "t0";
    const params: unknown[] = [];
    const assignments = cols
      .map((c) => {
        const expr = updateSet[c]!;
        if (expr.kind === "column" && cteNames.has(expr.alias)) {
          return `${this.escapeIdentifier(c)} = ${this.renderColumn(expr)}`;
        }
        if (expr.kind === "const") {
          params.push(expr.value);
          return `${this.escapeIdentifier(c)} = ${this.placeholder(params.length)}`;
        }
        throw new Error(`compileUpdate: unsupported SET expression for column "${c}"`);
      })
      .join(", ");
    const fixedWhere = this.fixMutationWhereAlias(table, whereSql, alias, useFrom);
    const where = this.renumberUpdateWhereParams(fixedWhere, params.length);
    params.push(...whereParams);
    let sql: string;
    if (useFrom) {
      const fromList = fromCtes.map((n) => this.escapeIdentifier(n)).join(", ");
      const whereClause = where ? ` WHERE ${where}` : "";
      sql = `UPDATE ${this.escapeIdentifier(table)} AS ${this.escapeIdentifier(alias)} SET ${assignments} FROM ${fromList}${whereClause}`;
    } else {
      sql = `UPDATE ${this.escapeIdentifier(table)} SET ${assignments} WHERE ${where}`;
    }
    if (options?.returning) sql += " RETURNING *";
    return { sql, params, returningRow: !!options?.returning };
  }

  protected compileDelete(
    table: string,
    whereSql: string,
    whereParams: unknown[],
    options?: {
      returning?: boolean;
      fromCtes?: string[];
      tableAlias?: string;
    },
  ): CompileResult {
    const fromCtes = options?.fromCtes ?? [];
    const useFrom = fromCtes.length > 0;
    const alias = options?.tableAlias ?? "t0";
    const fixedWhere = this.fixMutationWhereAlias(table, whereSql, alias, useFrom);
    let sql: string;
    if (useFrom) {
      const fromList = fromCtes.map((n) => this.escapeIdentifier(n)).join(", ");
      const existsWhere = fixedWhere || "1=1";
      sql = `DELETE FROM ${this.escapeIdentifier(table)} AS ${this.escapeIdentifier(alias)} WHERE EXISTS (SELECT 1 FROM ${fromList} WHERE ${existsWhere})`;
    } else {
      sql = `DELETE FROM ${this.escapeIdentifier(table)} WHERE ${fixedWhere}`;
    }
    if (options?.returning) sql += " RETURNING *";
    return { sql, params: whereParams, returningRow: !!options?.returning };
  }

  protected compileNode(node: Expr, params: unknown[]): string {
    switch (node.kind) {
      case "binary": {
        const left = this.compileNode(node.left, params);
        const right = this.compileNode(node.right, params);
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
        return `(NOT ${this.compileNode(node.operand, params)})`;
      case "column":
        return this.renderColumn(node);
      case "const":
        params.push(node.value);
        return this.placeholder(params.length);
      case "param":
        params.push({ __param: node.name });
        return this.placeholder(params.length);
      case "in":
        return this.compileInNode(node, params);
      case "exists":
        return this.compileExistsNode(node, params);
      case "subquery":
        return this.compileSubqueryPlan(node.plan, params);
      case "call": {
        const receiver = this.compileNode(node.receiver, params);
        if (
          node.method === "startsWith" ||
          node.method === "endsWith" ||
          node.method === "includes"
        ) {
          const arg = this.compileNode(node.args[0], params);
          return this.compileLike(receiver, arg, node.method);
        }
        throw new Error(`Unsupported method: ${node.method}`);
      }
      case "aggregate":
        return this.compileAggregate(node, params);
    }
  }

  protected compileSubqueryPlan(plan: QueryPlan, outerParams: unknown[]): string {
    const compiled = this.compilePlan(plan, {
      wrap: true,
      paramStartIndex: outerParams.length + 1,
    });
    outerParams.push(...compiled.params);
    return compiled.sql;
  }

  protected compileInNode(node: Expr & { kind: "in" }, params: unknown[]): string {
    const left = this.compileNode(node.left, params);
    const op = node.negated ? "NOT IN" : "IN";
    const rhs = node.right;
    if (rhs.kind === "values") {
      if (rhs.values.length === 0) return node.negated ? "1=1" : "1=0";
      const placeholders = rhs.values.map((v) => {
        params.push(v);
        return this.placeholder(params.length);
      });
      return `${left} ${op} (${placeholders.join(", ")})`;
    }
    if (rhs.kind === "param") {
      params.push({ __param: rhs.name });
      return `${left} ${op} (${this.placeholder(params.length)})`;
    }
    return `${left} ${op} ${this.compileSubqueryPlan(rhs.plan, params)}`;
  }

  protected compileExistsNode(node: Expr & { kind: "exists" }, params: unknown[]): string {
    const innerSql = this.compileNode(node.predicate, params);
    const wrappedSql = node.negated ? `(NOT (${innerSql}))` : innerSql;
    const existsSql = this.compileExists(
      node.targetTable,
      node.innerAlias,
      node.fkColumns,
      node.outerAlias,
      node.mainPk,
      wrappedSql,
    );
    return node.negated ? `(NOT ${existsSql})` : existsSql;
  }

  protected compileExists(
    targetTable: string,
    alias: string,
    fkColumns: string[],
    mainAlias: string,
    mainPk: string[],
    innerSql: string,
  ): string {
    const pkConds = fkColumns
      .map(
        (fk, i) =>
          `${this.escapeIdentifier(alias)}.${this.escapeIdentifier(fk)} = ${this.escapeIdentifier(mainAlias)}.${this.escapeIdentifier(mainPk[i] ?? mainPk[0])}`,
      )
      .join(" AND ");
    return `(EXISTS (SELECT 1 FROM ${this.escapeIdentifier(targetTable)} AS ${this.escapeIdentifier(alias)} WHERE ${pkConds} AND (${innerSql})))`;
  }

  protected compileLike(
    receiver: string,
    arg: string,
    mode: "startsWith" | "endsWith" | "includes",
  ): string {
    if (mode === "startsWith") return `(${receiver} LIKE ${arg} || '%')`;
    if (mode === "endsWith") return `(${receiver} LIKE '%' || ${arg})`;
    return `(${receiver} LIKE '%' || ${arg} || '%')`;
  }

  compileAggregate(agg: ExprAggregate, params: unknown[] = []): string {
    switch (agg.func) {
      case "SUM":
      case "AVG":
      case "MIN":
      case "MAX":
      case "COUNT":
        return this.compileStandardAggregate(agg.func, agg, params);
      default:
        throw new Error(
          `[typhex] Aggregate function "${agg.func}" is dialect-specific. Use the matching dialect query compiler.`,
        );
    }
  }

  protected buildJoinClause(join: JoinSpec, mainAlias: string, onSql?: string): string {
    const kw = BaseQueryCompiler.JOIN_SQL_KEYWORDS[join.joinType] ?? "LEFT JOIN";
    if (join.on) {
      return ` ${kw} ${this.escapeIdentifier(join.targetTable)} AS ${this.escapeIdentifier(join.alias)} ON ${onSql}`;
    }
    const on = join.foreignKeys
      .map(
        (fk, i) =>
          `${this.escapeIdentifier(mainAlias)}.${this.escapeIdentifier(fk)} = ${this.escapeIdentifier(join.alias)}.${this.escapeIdentifier(join.targetPkColumns[i] ?? join.targetPkColumns[0])}`,
      )
      .join(" AND ");
    return ` ${kw} ${this.escapeIdentifier(join.targetTable)} AS ${this.escapeIdentifier(join.alias)} ON ${on}`;
  }

  protected appendOnConflict(
    baseSql: string,
    onConflict: OnConflictClause,
    insertColumns: string[],
  ): string {
    const conflictCols = onConflict.conflictColumns
      .map((c) => this.escapeIdentifier(c))
      .join(", ");
    if (onConflict.action === "nothing") {
      return `${baseSql} ON CONFLICT (${conflictCols}) DO NOTHING`;
    }
    const updateCols = onConflict.updateColumns?.length
      ? onConflict.updateColumns
      : insertColumns.filter((c) => !onConflict.conflictColumns.includes(c));
    const setClauses = updateCols
      .map((c) => `${this.escapeIdentifier(c)} = ${this.excludedTableName()}.${this.escapeIdentifier(c)}`)
      .join(", ");
    return `${baseSql} ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClauses}`;
  }

  protected excludedTableName(): string {
    return "EXCLUDED";
  }

  protected singleInsertReturnsRows(hasPk: boolean): boolean {
    return hasPk;
  }

  protected renderInsertManyValue(value: unknown, paramIndex: number): { sql: string; params: unknown[] } {
    if (value === SQL_DEFAULT) return { sql: "DEFAULT", params: [] };
    return { sql: this.placeholder(paramIndex), params: [value] };
  }

  protected renumberUpdateWhereParams(whereSql: string, offset: number): string {
    if (this.dialect !== "postgres") return whereSql;
    return whereSql.replaceAll(/\$(\d+)/g, (_, n) => `$${Number.parseInt(n, 10) + offset}`);
  }

  protected registeredCteNames(plan: QueryPlan): Set<string> {
    return new Set(plan.ctes?.map((c) => c.name) ?? []);
  }

  protected collectReferencedCteNames(
    expr: Expr | null | undefined,
    registered: Set<string>,
  ): Set<string> {
    const refs = new Set<string>();
    if (!expr) return refs;
    const walk = (node: Expr): void => {
      switch (node.kind) {
        case "column":
          if (registered.has(node.alias)) refs.add(node.alias);
          break;
        case "binary":
          walk(node.left);
          walk(node.right);
          break;
        case "unary":
          walk(node.operand);
          break;
        case "in":
          walk(node.left);
          if (node.right.kind === "subquery" && node.right.plan.where) {
            walk(node.right.plan.where);
          }
          break;
        case "call":
          walk(node.receiver);
          for (const arg of node.args) walk(arg);
          break;
        case "exists":
          walk(node.predicate);
          break;
        case "aggregate":
          if (node.arg) walk(node.arg);
          break;
        case "subquery":
          if (node.plan.where) walk(node.plan.where);
          break;
        case "const":
        case "param":
          break;
      }
    };
    walk(expr);
    return refs;
  }

  protected orderedReferencedCtes(plan: QueryPlan, referenced: Set<string>): string[] {
    return (plan.ctes ?? []).map((c) => c.name).filter((n) => referenced.has(n));
  }

  protected collectMutationCteRefs(plan: QueryPlan, registered: Set<string>): Set<string> {
    const refs = this.collectReferencedCteNames(plan.where, registered);
    for (const expr of Object.values(plan.updateSet ?? {})) {
      for (const name of this.collectReferencedCteNames(expr, registered)) {
        refs.add(name);
      }
    }
    return refs;
  }

  protected assertFromCteRegistered(
    fromSource: FromSource | undefined,
    allowedCteNames: string[],
  ): void {
    if (fromSource?.kind !== "cte") return;
    if (!allowedCteNames.includes(fromSource.name)) {
      throw new Error(
        `from: unknown CTE ${JSON.stringify(fromSource.name)} — register it with withCte first`,
      );
    }
  }

  protected fixMutationWhereAlias(
    table: string,
    whereSql: string,
    alias = "t0",
    keepAlias = false,
  ): string {
    if (keepAlias) return whereSql;
    return whereSql.replaceAll('"t0".', `${this.escapeIdentifier(table)}.`);
  }

  protected compileCreateTable(
    table: string,
    schema: Record<string, ColumnDef>,
    ifNotExists: boolean,
  ): string {
    const cols = Object.entries(schema).map(
      ([c, def]) => `  ${this.escapeIdentifier(c)} ${this.toColumnDef(def)}`,
    );
    const existenceClause = ifNotExists ? " IF NOT EXISTS" : "";
    return `CREATE TABLE${existenceClause} ${this.escapeIdentifier(table)} (\n${cols.join(",\n")}\n);`;
  }

  protected compileRecreateDroppedTable(
    table: string,
    columnInfos: Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>,
  ): string {
    const cols = columnInfos.map(
      (c) => `  ${this.escapeIdentifier(c.name)} ${this.reconstructColDef(c)}`,
    );
    return `CREATE TABLE IF NOT EXISTS ${this.escapeIdentifier(table)} (\n${cols.join(",\n")}\n);`;
  }

  protected compileAlterColumn(action: AlterColumnAction, reverse: boolean): string {
    const dimensions = action.changes.map((c) => c.kind).join(", ");
    const direction = reverse ? "rollback" : "apply";
    throw new Error(
      `${this.dialect} cannot ${direction} ALTER COLUMN on ${action.table}.${action.column} ` +
        `(changes: ${dimensions}). The table must be recreated; please write the migration manually.`,
    );
  }

  protected reconstructColDef(col: {
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }): string {
    let def = col.type;
    if (col.pk) def += " PRIMARY KEY";
    else if (col.notnull) def += " NOT NULL";
    if (col.dflt_value !== null) def += ` DEFAULT ${col.dflt_value}`;
    return def;
  }

  private createExpander(options: CompileQueryOpts): {
    paramStartIndex: number;
    expand: (
      compiled: { sql: string; params: unknown[] },
      paramValues: Record<string, unknown>,
    ) => ExpandPlaceholdersResult;
  } {
    const paramStartIndex = options.paramStartIndex ?? 1;
    let nextOffset = paramStartIndex;
    return {
      paramStartIndex,
      expand: (compiled, paramValues) => {
        const out = this.expandPlaceholders(
          compiled.sql,
          resolveParamSentinels(compiled.params, paramValues),
          nextOffset,
        );
        nextOffset += out.params.length;
        return out;
      },
    };
  }
}
