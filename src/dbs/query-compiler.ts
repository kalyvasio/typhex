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
  RenderedWithClause,
} from "./types.js";
import { wrapWithPostgres, wrapWithSqlite } from "./with-clause.js";
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
import {
  assertFromSourceAllowed,
  renderCtes,
  resolveFromClause as resolvePlanFromClause,
} from "./cte-render.js";
import type { DialectName } from "./types.js";
import type { JoinType } from "../ir/types.js";

type AlterColumnAction = Extract<DiffAction, { kind: "alter_column" }>;

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
      case "count":
        return this.compileCountPlan(plan);
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
    const renderedCtes = renderCtes(this, plan.ctes, options.allowedCteNames);
    const allowedCteNames = [
      ...(options.allowedCteNames ?? []),
      ...renderedCtes.map((c) => c.name),
    ];
    assertFromSourceAllowed(plan.fromSource, allowedCteNames);

    const fromResolved = resolvePlanFromClause(
      this,
      plan,
      allowedCteNames,
      options.paramStartIndex ?? 1,
      options,
      (name) => this.escapeIdentifier(name),
    );
    const { expand, paramStartIndex } = this.createExpander({
      ...options,
      paramStartIndex: (options.paramStartIndex ?? 1) + fromResolved.fromParams.length,
    });
    const joinsSql = plan.joins.map((j) => this.buildJoinClause(j, plan.tableAlias)).join("");
    const selectListExpanded = expand(
      this.compileSelectListExpr(
        plan.selectItems,
        plan.selectAll,
        plan.tableAlias,
        plan.columnNames,
      ),
      plan.whereParams,
    );
    const whereExpanded = expand(this.compileWhereExpr(plan.where), plan.whereParams);
    const havingExpanded = plan.having
      ? expand(this.compileWhereExpr(plan.having), plan.havingParams)
      : null;
    const orderByExpanded = expand(this.compileOrderByExpr(plan.orderBy), plan.whereParams);
    const result = this.compileSelect({
      table: plan.tableName,
      tableAlias: plan.tableAlias,
      fromClause: fromResolved.fromClause,
      fromParams: fromResolved.fromParams,
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
    const wrapped = this.wrapWithRenderedCtes(result, renderedCtes);
    return options.wrap ? { sql: `(${wrapped.sql})`, params: wrapped.params } : wrapped;
  }

  protected compileCountPlan(plan: QueryPlan): CompileResult {
    const renderedCtes = renderCtes(this, plan.ctes);
    const allowedCteNames = renderedCtes.map((c) => c.name);
    assertFromSourceAllowed(plan.fromSource, allowedCteNames);

    const fromResolved = resolvePlanFromClause(
      this,
      plan,
      allowedCteNames,
      1,
      {},
      (name) => this.escapeIdentifier(name),
    );
    const { expand } = this.createExpander({
      paramStartIndex: 1 + fromResolved.fromParams.length,
    });
    const joinsSql = plan.joins.map((j) => this.buildJoinClause(j, plan.tableAlias)).join("");
    const whereExpanded = expand(this.compileWhereExpr(plan.where), plan.whereParams);
    return this.wrapWithRenderedCtes(
      this.compileCount(
        plan.tableName,
        plan.tableAlias,
        whereExpanded.sql,
        whereExpanded.params,
        joinsSql || undefined,
        fromResolved.fromClause,
        fromResolved.fromParams,
      ),
      renderedCtes,
    );
  }

  protected wrapWithRenderedCtes(
    result: CompileResult,
    rendered: RenderedWithClause[],
  ): CompileResult {
    if (!rendered.length) return result;
    if (this.dialect === "postgres") {
      return wrapWithPostgres(result.sql, result.params, rendered);
    }
    return wrapWithSqlite(result.sql, result.params, rendered);
  }

  protected compileUpdatePlan(plan: QueryPlan): CompileResult {
    if (plan.operation.kind !== "update") {
      throw new Error("compileUpdatePlan expects an update operation");
    }
    const { expand } = this.createExpander({});
    const whereExpanded = expand(this.compileWhereExpr(plan.where), plan.whereParams);
    return this.compileUpdate(
      plan.tableName,
      plan.operation.set,
      plan.columnNames,
      whereExpanded.sql,
      whereExpanded.params,
      { returning: plan.operation.returning },
    );
  }

  protected compileDeletePlan(plan: QueryPlan): CompileResult {
    if (plan.operation.kind !== "delete") {
      throw new Error("compileDeletePlan expects a delete operation");
    }
    const { expand } = this.createExpander({});
    const whereExpanded = expand(this.compileWhereExpr(plan.where), plan.whereParams);
    return this.compileDelete(plan.tableName, whereExpanded.sql, whereExpanded.params, {
      returning: plan.operation.returning,
    });
  }

  protected compileSelect(opts: CompileSelectOpts): CompileResult {
    const params = [...(opts.fromParams ?? []), ...(opts.selectListParams ?? []), ...opts.whereParams];
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
    let paramIdx = (opts.paramStartIndex ?? 1) + params.length;
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

  protected compileCount(
    table: string,
    tableAlias: string,
    whereSql: string,
    whereParams: unknown[],
    joinsSql?: string,
    fromClause?: string,
    fromParams?: unknown[],
  ): CompileResult {
    const fromPart =
      fromClause ?? `${this.escapeIdentifier(table)} AS ${this.escapeIdentifier(tableAlias)}`;
    return {
      sql: `SELECT COUNT(*) AS c FROM ${fromPart}${joinsSql ?? ""} WHERE ${whereSql}`,
      params: [...(fromParams ?? []), ...whereParams],
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
    set: Record<string, unknown>,
    columns: string[],
    whereSql: string,
    whereParams: unknown[],
    options?: { returning?: boolean },
  ): CompileResult {
    const cols = Object.keys(set).filter((k) => columns.includes(k));
    if (cols.length === 0) return { sql: "", params: [] };
    const assignments = cols
      .map((c, i) => `${this.escapeIdentifier(c)} = ${this.placeholder(i + 1)}`)
      .join(", ");
    const fixedWhere = this.fixMutationWhereAlias(table, whereSql);
    const where = this.renumberUpdateWhereParams(fixedWhere, cols.length);
    let sql = `UPDATE ${this.escapeIdentifier(table)} SET ${assignments} WHERE ${where}`;
    if (options?.returning) sql += " RETURNING *";
    return {
      sql,
      params: [...cols.map((c) => set[c]), ...whereParams],
      returningRow: !!options?.returning,
    };
  }

  protected compileDelete(
    table: string,
    whereSql: string,
    whereParams: unknown[],
    options?: { returning?: boolean },
  ): CompileResult {
    let sql = `DELETE FROM ${this.escapeIdentifier(table)} WHERE ${this.fixMutationWhereAlias(table, whereSql)}`;
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

  protected buildJoinClause(join: JoinSpec, mainAlias: string): string {
    const kw = BaseQueryCompiler.JOIN_SQL_KEYWORDS[join.joinType] ?? "LEFT JOIN";
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

  protected fixMutationWhereAlias(table: string, whereSql: string): string {
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
