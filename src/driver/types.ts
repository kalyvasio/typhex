/**
 * Driver abstraction for database execution.
 */

export interface Driver {
  /** Execute a single query; returns rows. */
  query(sql: string, params?: unknown[]): unknown[];
  /** Execute a single statement (insert/update/delete); returns lastID and changes. */
  run(sql: string, params?: unknown[]): { lastID?: number; changes: number };
  /** Run multiple statements in a transaction. */
  transaction<T>(fn: () => T): T;
  /** Close the connection. */
  close(): void;
}

export interface DriverResult {
  rows: unknown[];
  lastID?: number;
  changes: number;
}
