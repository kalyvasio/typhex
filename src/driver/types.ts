import type { Dialect } from "../dbs/types.js";
import type { Trx } from "../orm/trx.js";

/** Options forwarded to the underlying driver when beginning a transaction. */
export interface TransactionOptions {
  /** ANSI isolation level. SQLite only supports "SERIALIZABLE" (mapped to BEGIN IMMEDIATE). */
  isolationLevel?: "READ_UNCOMMITTED" | "READ_COMMITTED" | "REPEATABLE_READ" | "SERIALIZABLE";
  /**
   * Open the transaction as read-only (PostgreSQL only).
   * Generates: BEGIN [ISOLATION LEVEL ...] READ ONLY
   */
  readOnly?: boolean;
  /**
   * Make the transaction deferrable (PostgreSQL only).
   * Requires isolationLevel: "SERIALIZABLE" and readOnly: true.
   * Generates: BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE
   */
  deferrable?: boolean;
  /**
   * SQLite-native transaction mode. Takes precedence over isolationLevel for SQLite.
   * "deferred"  = BEGIN DEFERRED  (default — acquire locks lazily)
   * "immediate" = BEGIN IMMEDIATE (acquire write lock immediately)
   * "exclusive" = BEGIN EXCLUSIVE (block all other connections)
   */
  sqliteMode?: "deferred" | "immediate" | "exclusive";
}

/** Result returned by Driver.execute() and Connection.execute(). */
export interface ExecuteResult {
  /** Rows returned by the statement (non-empty for SELECT/WITH/PRAGMA/EXPLAIN). */
  rows: unknown[];
  /**
   * Auto-generated primary key from the last INSERT, when applicable.
   * MySQL: result.insertId  |  PostgreSQL: first RETURNING column  |  SQLite: lastInsertRowid
   */
  lastID?: number;
  /** Number of rows affected (INSERT/UPDATE/DELETE). */
  changes: number;
}

/** A dedicated connection acquired from the pool — used inside transactions. */
export interface Connection {
  /** The SQL dialect this connection speaks. */
  readonly dialect: Dialect;
  /**
   * Execute any SQL statement on this dedicated connection.
   * See Driver.execute() for the implementer mapping guide.
   */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
  /** Returns this connection to the pool. */
  release(): Promise<void>;
}

/** Thin adapter — raw DB operations only. Transaction logic lives in Db. */
export interface Driver {
  /** The SQL dialect this driver targets. */
  readonly dialect: Dialect;
  /**
   * Execute any SQL statement. Returns rows (for SELECT) and mutation
   * metadata (for INSERT/UPDATE/DELETE).
   *
   * Implementer mapping:
   *   MySQL:      rows = result,       lastID = result.insertId,     changes = result.affectedRows
   *   PostgreSQL: rows = result.rows,  lastID = first RETURNING col, changes = result.rowCount
   *   SQLite:     rows = stmt.all(),   lastID = lastInsertRowid,     changes = info.changes
   */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
  /** Acquire a dedicated connection (e.g. pg.PoolClient, or SQLite db wrapper). */
  connect(): Promise<Connection>;
  /** Create a dialect-specific transaction scope for the given connection. */
  createTrx(conn: Connection, options?: TransactionOptions): Trx;
  /** Closes all pooled connections and tears down the driver. */
  close(): Promise<void>;
}
