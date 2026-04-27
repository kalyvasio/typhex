/**
 * Create driver from dialect and connection options.
 */

import type { Driver } from "./types.js";
import { createSqliteDriver } from "./sqlite.js";
import type { SqliteDriverOptions } from "./sqlite.js";
import { createPostgresDriver } from "../dbs/postgres/driver.js";
import type { PostgresDriverOptions } from "../dbs/postgres/driver.js";

/** SQLite driver options (path required). */
export type { SqliteDriverOptions };

/** PostgreSQL driver options (connectionString or host/port/database). */
export type { PostgresDriverOptions };

/** Union of driver options — use `dialect` to discriminate. */
export type CreateDriverOptions =
  | ({ dialect: "sqlite" } & SqliteDriverOptions)
  | ({ dialect: "postgres" } & PostgresDriverOptions);

/** Creates a driver from a discriminated options object (`{ dialect: 'sqlite' | 'postgres', … }`). */
export function createDriver(options: CreateDriverOptions): Driver {
  switch (options.dialect) {
    case "sqlite": {
      const { dialect: _, ...rest } = options;
      if (rest.path === undefined && rest.database === undefined) {
        return createSqliteDriver({ ...rest, path: ":memory:" });
      }
      return createSqliteDriver(rest);
    }
    case "postgres": {
      const { dialect: _, ...rest } = options;
      return createPostgresDriver(rest);
    }
    default:
      throw new Error(`Unknown dialect: ${(options as { dialect: string }).dialect}`);
  }
}
