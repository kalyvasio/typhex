/**
 * SQLite driver using better-sqlite3.
 * Serializes Date/boolean so bound params are valid for SQLite (numbers, strings, bigints, buffers, null).
 */

import { createRequire } from "node:module";
import type { Driver } from "./types.js";

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
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return JSON.stringify(value);
  return value;
}

function bindableParams(params: unknown[]): unknown[] {
  return params.map(toBindable);
}

export interface SqliteDriverOptions {
  /** Path to database file or ":memory:" */
  path: string;
}

export function createSqliteDriver(options: SqliteDriverOptions): Driver {
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(options.path);

  return {
    query(sql: string, params: unknown[] = []): unknown[] {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...bindableParams(params)) as unknown[];
      return rows;
    },

    run(sql: string, params: unknown[] = []): { lastID?: number; changes: number } {
      const stmt = db.prepare(sql);
      const info = stmt.run(...bindableParams(params)) as { lastInsertRowid: number; changes: number };
      return {
        lastID: info.lastInsertRowid,
        changes: info.changes,
      };
    },

    transaction<T>(fn: () => T): T {
      const tr = db.transaction(fn);
      return tr();
    },

    close(): void {
      db.close();
    },
  };
}
