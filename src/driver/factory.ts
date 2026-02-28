/**
 * Create driver from dialect and connection options.
 */

import type { Driver } from "./types.js";
import type { Dialect } from "../dialect.js";
import { createSqliteDriver } from "./sqlite.js";

export interface CreateDriverOptions {
  dialect: Dialect;
  /** SQLite: path to database file or ":memory:" */
  database?: string;
  /** PostgreSQL: connection URL (future) */
  url?: string;
}

export function createDriver(options: CreateDriverOptions): Driver {
  switch (options.dialect) {
    case "sqlite": {
      const path = options.database ?? ":memory:";
      return createSqliteDriver({ path });
    }
    case "postgres":
      throw new Error("PostgreSQL driver not yet implemented. Use dialect: 'sqlite'.");
    default:
      throw new Error(`Unknown dialect: ${options.dialect}`);
  }
}
