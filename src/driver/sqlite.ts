/**
 * SQLite driver using better-sqlite3.
 * Serializes Date/boolean so bound params are valid for SQLite (numbers, strings, bigints, buffers, null).
 */

import { createRequire } from "node:module";
import type { Driver, Connection, ExecuteResult, TransactionOptions } from "./types.js";
import { SqliteTrx } from "../dbs/sqlite/trx.js";
import { isRecord } from "../utils.js";

const require = createRequire(import.meta.url);

/** Convert a value to a type SQLite can bind (number, string, bigint, Buffer, null). */
function toBindable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    Buffer.isBuffer(value)
  )
    return value;
  if (isRecord(value)) return JSON.stringify(value);
  return value;
}

function bindableParams(params: unknown[]): unknown[] {
  return params.map(toBindable);
}

/** Execute a statement against the better-sqlite3 Database instance. */
function executeSql(
  db: import("better-sqlite3").Database,
  sql: string,
  params: unknown[],
): ExecuteResult {
  const stmt = db.prepare(sql);
  if (stmt.reader) {
    return { rows: stmt.all(...bindableParams(params)), changes: 0 };
  }
  const info = stmt.run(...bindableParams(params)) as { lastInsertRowid: number; changes: number };
  return { rows: [], lastID: info.lastInsertRowid, changes: info.changes };
}

export interface SqliteDriverOptions {
  /** Path to database file or ":memory:" */
  path: string;
}

export function createSqliteDriver(options: SqliteDriverOptions): Driver {
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(options.path);

  function makeConnection(): Connection {
    return {
      dialect: "sqlite" as const,
      async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
        return executeSql(db, sql, params);
      },
      async release(): Promise<void> {
        /* no-op for SQLite */
      },
    };
  }

  return {
    dialect: "sqlite" as const,

    async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
      return executeSql(db, sql, params);
    },

    connect(): Promise<Connection> {
      return Promise.resolve(makeConnection());
    },

    createTrx(conn: Connection, options?: TransactionOptions) {
      return new SqliteTrx(conn, options);
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
