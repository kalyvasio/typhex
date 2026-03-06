import type { Dialect } from "../dialect.js";

/**
 * Driver abstraction for database execution. All methods are async.
 */
export interface Driver {
  /** Database dialect (for dialect-aware SQL generation). */
  dialect: Dialect;
  /** Execute a single query; returns rows. */
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  /** Execute a single statement (insert/update/delete); returns lastID and changes. */
  run(sql: string, params?: unknown[]): Promise<{ lastID?: number; changes: number }>;
  /** Run multiple statements in a transaction. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Close the connection. */
  close(): Promise<void>;
}

export interface DriverResult {
  rows: unknown[];
  lastID?: number;
  changes: number;
}
