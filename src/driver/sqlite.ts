/**
 * SQLite driver using better-sqlite3.
 */

import { createRequire } from "node:module";
import type { Driver } from "./types.js";

const require = createRequire(import.meta.url);

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
      const rows = stmt.all(...params) as unknown[];
      return rows;
    },

    run(sql: string, params: unknown[] = []): { lastID?: number; changes: number } {
      const stmt = db.prepare(sql);
      const info = stmt.run(...params) as { lastInsertRowid: number; changes: number };
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
