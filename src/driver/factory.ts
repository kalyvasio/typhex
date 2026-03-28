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

/** Union of driver options - use dialect to discriminate. */
export type CreateDriverOptions =
  | ({ dialect: "sqlite" } & SqliteDriverOptions)
  | ({ dialect: "postgres" } & PostgresDriverOptions);

/** Config-compatible options (database as path for sqlite, url for postgres). */
export interface CreateDriverConfigCompat {
  dialect: "sqlite" | "postgres";
  path?: string;
  database?: string;
  url?: string;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  ssl?: PostgresDriverOptions["ssl"];
  poolMin?: number;
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export function createDriver(options: CreateDriverOptions | CreateDriverConfigCompat): Driver {
  switch (options.dialect) {
    case "sqlite": {
      const path = (options as { path?: string }).path ?? (options as { database?: string }).database ?? ":memory:";
      return createSqliteDriver({ path });
    }
    case "postgres": {
      const o = options as CreateDriverConfigCompat;
      const connectionString = o.connectionString ?? o.url;
      const poolOpts = {
        ssl: o.ssl,
        poolMin: o.poolMin,
        poolMax: o.poolMax,
        idleTimeoutMs: o.idleTimeoutMs,
        connectionTimeoutMs: o.connectionTimeoutMs,
      };
      if (connectionString) {
        return createPostgresDriver({ connectionString, ...poolOpts });
      }
      return createPostgresDriver({
        host: o.host,
        port: o.port,
        database: o.database,
        user: o.user,
        password: o.password,
        ...poolOpts,
      });
    }
    default:
      throw new Error(`Unknown dialect: ${(options as { dialect: string }).dialect}`);
  }
}
