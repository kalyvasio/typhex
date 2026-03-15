/**
 * Multi-database types: Driver, Dialect, DbMigrations.
 */

import type { IrNode, IrOrderBy, IrSelect } from "../ir/types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";
import type { RelationJoinInfo } from "../orm/relation-joins.js";

export type Dialect = "sqlite" | "postgres";

/** Column definition: string (all dialects) or per-dialect map. */
export type ColumnDef = string | { [K in Dialect]?: string };

export interface CompileResult {
  sql: string;
  params: unknown[];
  /** When true, execution via driver.query() returns the inserted row (e.g. INSERT ... RETURNING *). */
  returningRow?: boolean;
}

export interface CompileOptions {
  tableAlias?: string;
  paramToAlias?: Record<string, string>;
  /** Map "param.relationKey" (e.g. "p.author") to joined table alias (e.g. "t1") */
  relationPathToAlias?: Record<string, string>;
  /** One-to-many relations in where: compile as EXISTS. Key "param.relationKey" -> EXISTS subquery info. */
  oneToManyExists?: Record<string, { targetTable: string; fkColumn: string; mainPk: string; alias: string }>;
}

export interface DbColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export type DiffAction =
  | { kind: "add_table"; table: string; schema: Record<string, ColumnDef> }
  | { kind: "drop_table"; table: string }
  | { kind: "add_column"; table: string; column: string; definition: ColumnDef }
  | { kind: "drop_column"; table: string; column: string }
  | { kind: "alter_column"; table: string; column: string; oldDef: string; newDef: ColumnDef };

/** Async driver interface. */
export interface Driver {
  dialect: Dialect;
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  run(sql: string, params?: unknown[]): Promise<{ lastID?: number; changes: number }>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

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
}

/** Resolve __param sentinels to actual values. Shared by all dialects. */
export function resolveParamSentinels(
  params: unknown[],
  paramValues: Record<string, unknown>
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

/** Dialect: SQL compilation and schema translation. */
export interface DialectImpl {
  readonly name: Dialect;
  escapeIdentifier(name: string): string;
  placeholder(index: number): string;
  /** Replace placeholders in SQL with resolved values; expand IN arrays. */
  expandPlaceholders(sql: string, resolvedParams: unknown[]): ExpandPlaceholdersResult;
  compileWhere(node: IrNode | null, opts: CompileOptions): CompileResult;
  compileOrderBy(orders: IrOrderBy[], opts: CompileOptions): string;
  compileSelectList(select: IrSelect | null, columns: string[], opts: CompileOptions): string;
  toColumnDef(def: ColumnDef): string;
  compileInsert(table: string, columns: string[], values: unknown[], pk?: string): CompileResult;
  compileCount(table: string, whereSql: string, whereParams: unknown[], joinsSql?: string): CompileResult;
  compileUpdate(table: string, set: Record<string, unknown>, columns: string[], whereSql: string, whereParams: unknown[]): CompileResult;
  compileDelete(table: string, whereSql: string, whereParams: unknown[]): CompileResult;
  compileSelect(opts: CompileSelectOpts): CompileResult;
  buildJoinClause(join: RelationJoinInfo): string;
}

/** DB-specific migrations: diff, DDL generation, and runner support. */
export interface DbMigrations {
  readonly dialect: Dialect;
  getDbTables(driver: Driver): Promise<string[]>;
  getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]>;
  diffSchema(driver: Driver, entities: readonly RegisteredEntity[]): Promise<DiffAction[]>;
  generateSql(action: DiffAction): string;
  /** DDL for the _typhex_migrations tracking table. */
  getTrackingTableDdl(): string;
  /** INSERT SQL for recording a migration (single placeholder for name). */
  getRecordMigrationSql(): string;
}

/** Resolve column definition for a dialect. */
export function getColumnDef(def: ColumnDef, dialect: Dialect): string {
  if (typeof def === "string") return def;
  return def[dialect] ?? def.sqlite ?? def.postgres ?? "";
}
