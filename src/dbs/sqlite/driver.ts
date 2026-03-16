/**
 * SQLite driver using better-sqlite3. Async wrapper.
 */

import { createRequire } from "node:module";
import type { Driver, TransactionOptions } from "../types.js";

const require = createRequire(import.meta.url);

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
  path: string;
}

export function createSqliteDriver(options: SqliteDriverOptions): Driver {
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(options.path);

  // Track nesting depth per driver instance
  let txDepth = 0;

  return {
    dialect: "sqlite",

    async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
      const stmt = db.prepare(sql);
      return Promise.resolve(stmt.all(...bindableParams(params)) as unknown[]);
    },

    async run(sql: string, params: unknown[] = []): Promise<{ lastID?: number; changes: number }> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...bindableParams(params)) as { lastInsertRowid: number; changes: number };
      return Promise.resolve({
        lastID: info.lastInsertRowid,
        changes: info.changes,
      });
    },

    async transaction<T>(fn: () => Promise<T>, options?: TransactionOptions): Promise<T> {
      if (txDepth > 0) {
        // Nested transaction: use savepoints
        const savepointName = `sp_${txDepth}`;
        txDepth++;
        try {
          db.exec(`SAVEPOINT ${savepointName}`);
          const result = await fn();
          db.exec(`RELEASE SAVEPOINT ${savepointName}`);
          return result;
        } catch (e) {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          throw e;
        } finally {
          txDepth--;
        }
      }

      const begin = options?.isolationLevel === "SERIALIZABLE" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED";
      txDepth++;
      try {
        db.exec(begin);
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        txDepth--;
      }
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
