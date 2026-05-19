import {
  BaseQueryCompiler,
  JOIN_SQL_KEYWORDS,
  compileAggregate,
  compileConcatAggregate,
  compileStandardAggregate,
} from "../query-compiler.js";
import type { CompileResult, DiffAction, ExpandPlaceholdersResult } from "../types.js";
import type { Expr, ExprAggregate, JoinSpec } from "../../orm/expr.js";

type AlterColumnAction = Extract<DiffAction, { kind: "alter_column" }>;

export class PostgresQueryCompiler extends BaseQueryCompiler {
  protected readonly dialect = "postgres" as const;

  compileNextSequenceValues(): CompileResult {
    throw new Error("Postgres sequence allocation is not configured for this dialect yet");
  }

  compileTrackingTable(): CompileResult {
    return {
      sql: `CREATE TABLE IF NOT EXISTS ${this.escapeIdentifier("_typhex_migrations")} (
  ${this.escapeIdentifier("id")} SERIAL PRIMARY KEY,
  ${this.escapeIdentifier("name")} TEXT NOT NULL UNIQUE,
  ${this.escapeIdentifier("applied_at")} TIMESTAMP NOT NULL DEFAULT NOW()
)`,
      params: [],
    };
  }

  compileListTables(): CompileResult {
    return {
      sql: `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != '_typhex_migrations'
    `,
      params: [],
    };
  }

  compileListColumns(table: string): CompileResult {
    return {
      sql: `
      SELECT column_name as name, data_type as type,
             CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END as notnull,
             column_default as dflt_value,
             CASE WHEN column_name IN (
               SELECT kcu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
               WHERE tc.table_schema = 'public'
                 AND tc.table_name = $1
                 AND tc.constraint_type = 'PRIMARY KEY'
             ) THEN 1 ELSE 0 END as pk
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
      params: [table],
    };
  }

  protected expandPlaceholders(
    sql: string,
    resolvedParams: unknown[],
    startIdx = 1,
  ): ExpandPlaceholdersResult {
    let idx = 0;
    const newParams: unknown[] = [];
    let paramIndex = startIdx;
    const newSql = sql.replaceAll(/\$(\d+)/g, () => {
      const v = resolvedParams[idx++];
      if (Array.isArray(v)) {
        v.forEach((x) => newParams.push(x));
        return v.map(() => `$${paramIndex++}`).join(", ");
      }
      newParams.push(v);
      return `$${paramIndex++}`;
    });
    return { sql: newSql, params: newParams };
  }

  protected compileAggregate(
    agg: ExprAggregate,
    compileNodeFn?: (node: Expr, params: unknown[]) => string,
    params?: unknown[],
  ): string {
    if (agg.func === "GROUP_CONCAT" || agg.func === "STRING_AGG") {
      return compileConcatAggregate("STRING_AGG", agg, "','", compileNodeFn, params);
    }
    if (agg.func === "ARRAY_AGG" || agg.func === "JSON_AGG") {
      return compileStandardAggregate(agg.func, agg, compileNodeFn, params);
    }
    return compileAggregate(agg, compileNodeFn, params);
  }

  protected buildJoinClause(join: JoinSpec, mainAlias: string): string {
    const kw =
      join.joinType === "cross" ? "INNER JOIN" : (JOIN_SQL_KEYWORDS[join.joinType] ?? "LEFT JOIN");
    const on = join.foreignKeys
      .map(
        (fk, i) =>
          `${this.escapeIdentifier(mainAlias)}.${this.escapeIdentifier(fk)} = ${this.escapeIdentifier(join.alias)}.${this.escapeIdentifier(join.targetPkColumns[i] ?? join.targetPkColumns[0])}`,
      )
      .join(" AND ");
    return ` ${kw} ${this.escapeIdentifier(join.targetTable)} AS ${this.escapeIdentifier(join.alias)} ON ${on}`;
  }

  protected compileAlterColumn(action: AlterColumnAction, reverse: boolean): string {
    const table = this.escapeIdentifier(action.table);
    const column = this.escapeIdentifier(action.column);
    return action.changes
      .map((change) => {
        switch (change.kind) {
          case "type": {
            const type = reverse ? change.from : change.to;
            return `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type};`;
          }
          case "not_null":
          case "nullable": {
            const notNull = reverse ? change.from : change.to;
            const operation = notNull ? "SET NOT NULL" : "DROP NOT NULL";
            return `ALTER TABLE ${table} ALTER COLUMN ${column} ${operation};`;
          }
          case "default": {
            const value = reverse ? change.from : change.to;
            const operation = value == null ? "DROP DEFAULT" : `SET DEFAULT ${value}`;
            return `ALTER TABLE ${table} ALTER COLUMN ${column} ${operation};`;
          }
          case "primary_key":
            throw new Error(
              `Primary key change on ${action.table}.${action.column} requires a manual migration; ` +
                `Postgres ALTER TABLE cannot add or drop a PK in isolation.`,
            );
        }
      })
      .join("\n");
  }
}

export const postgresQueryCompiler = new PostgresQueryCompiler();
