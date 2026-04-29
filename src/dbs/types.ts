/**
 * Multi-database types: Driver, Dialect, DialectImpl.
 */

import type { IrNode, IrOrderBy, IrSelect, IrAggregate } from "../ir/types.js";
import type { Connection, ExecuteResult } from "../driver/types.js";
import type { RelationJoinInfo } from "../orm/helpers/relations/relation-joins.js";
import type { Dialect } from "../dialect.js";

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

export interface CompileOptions {
  tableAlias?: string;
  paramToAlias?: Record<string, string>;
  /** Map "param.relationKey" (e.g. "p.author") to joined table alias (e.g. "t1") */
  relationPathToAlias?: Record<string, string>;
  /** One-to-many relations in where: compile as EXISTS. Key "param.relationKey" -> EXISTS subquery info. */
  oneToManyExists?: Record<
    string,
    { targetTable: string; fkColumns: string[]; mainPk: string[]; alias: string }
  >;
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
  selectList: string;
  whereSql: string;
  whereParams: unknown[];
  orderBySql: string;
  limitNum: number | null;
  offsetNum: number | null;
  joinsSql?: string;
  groupBy?: Array<string[] | number>;
  compileOpts?: CompileOptions;
  havingSql?: string;
  havingParams?: unknown[];
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

/** Resolved (non-optional) compile options, produced by resolveOpts(). */
export type ResolvedOpts = {
  tableAlias: string;
  paramToAlias: Record<string, string>;
  relationPathToAlias?: Record<string, string>;
  oneToManyExists?: Record<
    string,
    { targetTable: string; fkColumns: string[]; mainPk: string[]; alias: string }
  >;
};

/** Dialect: SQL compilation and schema translation. */
export interface DialectImpl {
  readonly name: Dialect;
  readonly insertCapabilities: DialectInsertCapabilities;
  compileNextSequenceValues(tableName: string, pkColumn: string, count: number): CompileResult;
  escapeIdentifier(name: string): string;
  placeholder(index: number): string;
  expandPlaceholders(
    sql: string,
    resolvedParams: unknown[],
    startIdx?: number,
  ): ExpandPlaceholdersResult;
  compileExists(
    targetTable: string,
    alias: string,
    fkColumns: string[],
    mainAlias: string,
    mainPk: string[],
    innerSql: string,
  ): string;
  compileLike(receiver: string, arg: string, mode: "startsWith" | "endsWith" | "includes"): string;
  compileAggregate?(
    agg: IrAggregate,
    opts?: ResolvedOpts,
    compileNodeFn?: (node: IrNode, opts: ResolvedOpts, params: unknown[]) => string,
    params?: unknown[],
  ): string;
  compileWhere(node: IrNode | null, opts: CompileOptions): CompileResult;
  compileOrderBy(orders: IrOrderBy[], opts: CompileOptions): string;
  compileSelectList(select: IrSelect | null, columns: string[], opts: CompileOptions): string;
  toColumnDef(def: ColumnDef): string;
  compileInsert(
    table: string,
    columns: string[],
    values: unknown[],
    pk?: string[],
    onConflict?: OnConflictClause,
  ): CompileResult;
  compileInsertMany(
    table: string,
    columns: string[],
    rows: unknown[][],
    pk?: string[],
    onConflict?: OnConflictClause,
  ): CompileResult;
  compileCount(
    table: string,
    whereSql: string,
    whereParams: unknown[],
    joinsSql?: string,
  ): CompileResult;
  compileUpdate(
    table: string,
    set: Record<string, unknown>,
    columns: string[],
    whereSql: string,
    whereParams: unknown[],
    options?: { returning?: boolean },
  ): CompileResult;
  compileDelete(
    table: string,
    whereSql: string,
    whereParams: unknown[],
    options?: { returning?: boolean },
  ): CompileResult;
  compileSelect(opts: CompileSelectOpts): CompileResult;
  buildJoinClause(join: RelationJoinInfo): string;
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
