/**
 * Multi-database types: Driver, Dialect, DialectImpl.
 */

import type { Connection, ExecuteResult } from "../driver/types.js";
import type { Dialect } from "../dialect.js";
import type { GroupByItem } from "../orm/expr.js";
import type { QueryPlan } from "../orm/helpers/query-plan/query-plan.js";

export type { Dialect };

/** Column definition: string (all dialects) or per-dialect map. */
export type ColumnDef = string | { [K in Dialect]?: string };

export interface CompileResult {
  sql: string;
  params: unknown[];
  /** When true, execution via driver.query() returns the inserted row (e.g. INSERT ... RETURNING *). */
  returningRow?: boolean;
}

/** Appended to INSERT ... as ON CONFLICT ... (Postgres / SQLite 3.24+). */
export interface OnConflictClause {
  conflictColumns: string[];
  action: "update" | "nothing";
  updateColumns?: string[];
}

export interface DbColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** A single dimension in which a DB column has drifted from the entity definition. */
export type ColumnChange =
  | { kind: "type"; from: string; to: string }
  | { kind: "not_null" | "nullable"; from: boolean; to: boolean }
  | { kind: "default"; from: string | null; to: string | null }
  | { kind: "primary_key"; from: boolean; to: boolean };

export type DiffAction =
  | { kind: "add_table"; table: string; schema: Record<string, ColumnDef> }
  | { kind: "drop_table"; table: string; columnInfos: DbColumnInfo[] }
  | { kind: "add_column"; table: string; column: string; definition: ColumnDef }
  | { kind: "drop_column"; table: string; column: string; columnInfo: DbColumnInfo }
  | {
      kind: "alter_column";
      table: string;
      column: string;
      oldDef: string;
      newDef: ColumnDef;
      columnInfo: DbColumnInfo;
      changes: ColumnChange[];
    };

export type { Connection, ExecuteResult };
export type { TransactionOptions, Driver } from "../driver/types.js";

/** Options for compileSelect. */
export interface CompileSelectOpts {
  table: string;
  tableAlias: string;
  selectList: string;
  /** Params bound to placeholders in `selectList` (subquery columns). */
  selectListParams?: unknown[];
  whereSql: string;
  whereParams: unknown[];
  orderBySql: string;
  orderByParams?: unknown[];
  limitNum: number | null;
  offsetNum: number | null;
  joinsSql?: string;
  groupBy?: GroupByItem[];
  havingSql?: string;
  havingParams?: unknown[];
  /** Absolute index for the next placeholder. */
  paramStartIndex?: number;
}

export type QueryOperation =
  | { kind: "select" }
  | { kind: "count" }
  | {
      kind: "insert";
      columns: string[];
      values: unknown[];
      pk?: string[];
      onConflict?: OnConflictClause;
    }
  | {
      kind: "insertMany";
      columns: string[];
      rows: unknown[][];
      pk?: string[];
      onConflict?: OnConflictClause;
    }
  | { kind: "update"; set: Record<string, unknown>; returning?: boolean }
  | { kind: "delete"; returning?: boolean };

export interface CompileQueryOpts {
  /** Wrap the assembled SELECT in `( … )` and return flat positional params,
   *  for use as a subquery. */
  wrap?: boolean;
  paramStartIndex?: number;
}

/** Sentinel that tells a dialect to emit the column's DB default rather than a value. */
export const SQL_DEFAULT: unique symbol = Symbol("SQL_DEFAULT");
export type SqlDefault = typeof SQL_DEFAULT;

/** Resolve __param sentinels to actual values. Shared by all dialects. */
export function resolveParamSentinels(
  params: unknown[],
  paramValues: Record<string, unknown>,
): unknown[] {
  const PARAM_SENTINEL = "__param" as const;
  const isSentinel = (p: unknown): p is { __param: string } =>
    typeof p === "object" && p !== null && PARAM_SENTINEL in p;
  const out: unknown[] = [];
  for (const p of params) {
    out.push(isSentinel(p) ? paramValues[p.__param] : p);
  }
  return out;
}

/** Expand placeholders: replace each placeholder with value, flatten IN arrays. */
export interface ExpandPlaceholdersResult {
  sql: string;
  params: unknown[];
}

export interface DialectInsertCapabilities {
  supportsReturning: boolean;
  supportsSequences: boolean;
}

/** Dialect: SQL compilation and schema translation. */
export interface DialectImpl {
  readonly name: Dialect;
  readonly insertCapabilities: DialectInsertCapabilities;
}

/** Public SQL-building surface for a dialect. */
export interface QueryCompiler {
  readonly dialect: Dialect;
  readonly insertCapabilities: DialectInsertCapabilities;
  compilePlan(plan: QueryPlan, opts?: CompileQueryOpts): CompileResult;
  compileMigrationUp(action: DiffAction): string;
  compileMigrationDown(action: DiffAction): string;
  compileCreateTableIfNotExists(table: string, schema: Record<string, ColumnDef>): string;
  compileTrackingTable(): CompileResult;
  compileAppliedMigrations(): CompileResult;
  compileRecordMigration(name: string): CompileResult;
  compileDeleteMigration(name: string): CompileResult;
  compileListTables(): CompileResult;
  compileListColumns(table: string): CompileResult;
  compileNextSequenceValues(tableName: string, pkColumn: string, count: number): CompileResult;
}

/** Resolve column definition for a dialect. */
export function getColumnDef(def: ColumnDef, dialect: Dialect): string {
  if (typeof def === "string") return def;
  const resolved = def[dialect] ?? def.sqlite ?? def.postgres;
  if (resolved == null) {
    throw new Error(`No column definition provided for dialect "${dialect}"`);
  }
  return resolved;
}
