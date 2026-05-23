import { BaseQueryCompiler } from "../query-compiler.js";
import type { CompileResult, DiffAction, ExpandPlaceholdersResult, CompiledCteBody } from "../types.js";
import { SQL_DEFAULT } from "../types.js";
import type { ExprAggregate } from "../../orm/expr.js";

type AlterColumnAction = Extract<DiffAction, { kind: "alter_column" }>;

export class SqliteQueryCompiler extends BaseQueryCompiler {
  protected readonly dialect = "sqlite" as const;

  compileNextSequenceValues(): CompileResult {
    throw new Error("SQLite does not support sequence allocation");
  }

  compileTrackingTable(): CompileResult {
    return {
      sql: `CREATE TABLE IF NOT EXISTS ${this.escapeIdentifier("_typhex_migrations")} (
  ${this.escapeIdentifier("id")} integer primary key autoincrement,
  ${this.escapeIdentifier("name")} text not null unique,
  ${this.escapeIdentifier("applied_at")} text not null default (datetime('now'))
)`,
      params: [],
    };
  }

  compileListTables(): CompileResult {
    return {
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_typhex_migrations'`,
      params: [],
    };
  }

  compileListColumns(table: string): CompileResult {
    return { sql: `PRAGMA table_info(${this.escapeIdentifier(table)})`, params: [] };
  }

  protected expandPlaceholders(
    sql: string,
    resolvedParams: unknown[],
    _startIdx?: number,
  ): ExpandPlaceholdersResult {
    let idx = 0;
    const newParams: unknown[] = [];
    const newSql = sql.replaceAll("?", () => {
      const v = resolvedParams[idx++];
      if (Array.isArray(v)) {
        v.forEach((x) => newParams.push(x));
        return v.map(() => "?").join(", ");
      }
      newParams.push(v);
      return "?";
    });
    return { sql: newSql, params: newParams };
  }

  protected compileWithClause(
    coreSql: string,
    coreParams: unknown[],
    bodies: CompiledCteBody[],
  ): CompileResult {
    const merged: unknown[] = [];
    for (const body of bodies) merged.push(...body.bodyParams);
    merged.push(...coreParams);
    const parts = bodies
      .map((body) => `${this.escapeIdentifier(body.name)} AS (${body.bodySql})`)
      .join(", ");
    return { sql: `WITH ${parts} ${coreSql}`, params: merged };
  }

  compileAggregate(agg: ExprAggregate, params: unknown[] = []): string {
    switch (agg.func) {
      case "GROUP_CONCAT":
        return this.compileConcatAggregate("GROUP_CONCAT", agg, undefined, params);
      default:
        return super.compileAggregate(agg, params);
    }
  }

  protected excludedTableName(): string {
    return "excluded";
  }

  protected singleInsertReturnsRows(): boolean {
    return false;
  }

  protected compileAlterColumn(action: AlterColumnAction, reverse: boolean): string {
    const dimensions = action.changes.map((c) => c.kind).join(", ");
    const direction = reverse ? "rollback" : "apply";
    throw new Error(
      `SQLite cannot ${direction} ALTER COLUMN on ${action.table}.${action.column} ` +
        `(changes: ${dimensions}). The table must be recreated; please write the migration manually.`,
    );
  }

  protected renderInsertManyValue(
    value: unknown,
    paramIndex: number,
  ): { sql: string; params: unknown[] } {
    return {
      sql: this.placeholder(paramIndex),
      params: [value === SQL_DEFAULT ? null : value],
    };
  }
}

export const sqliteQueryCompiler = new SqliteQueryCompiler();
