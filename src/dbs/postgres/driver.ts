/**
 * PostgreSQL driver using pg.Pool.
 * Thin adapter: execute(), connect(), close() only — no transaction logic.
 */

import pg from "pg";
import type { Driver, Connection, ExecuteResult, TransactionOptions } from "../../driver/types.js";
import { PostgresTrx } from "./trx.js";
import { postgresDialect } from "./dialect.js";
import { isRecord } from "../../utils.js";

const { Pool } = pg;
type PoolClient = pg.PoolClient;

function toBindable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value;
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

/** Options for `createPostgresDriver`: `connectionString` (or alias `url`) and optional pool sizing. */
export interface PostgresDriverOptions {
  /** Full PostgreSQL connection string (e.g. `postgres://user:pass@host/db`). */
  connectionString?: string;
  /** Alias for `connectionString`. Useful when reading from a config file. */
  url?: string;
  /** PostgreSQL server hostname (used when `connectionString` is not provided). */
  host?: string;
  /** PostgreSQL server port (default: `5432`). */
  port?: number;
  /** Database name (default: `'postgres'`). */
  database?: string;
  /** Database user. */
  user?: string;
  /** Database password. */
  password?: string;
  /** SSL configuration forwarded to `pg`. */
  ssl?: pg.ConnectionConfig["ssl"];
  /** Minimum pool connections to keep open (default: `2`). */
  poolMin?: number;
  /** Maximum pool size (default: `10`). */
  poolMax?: number;
  /** Milliseconds before an idle connection is released (default: `30000`). */
  idleTimeoutMs?: number;
  /** Milliseconds to wait for a connection from the pool (default: `5000`). */
  connectionTimeoutMs?: number;
  /** PostgreSQL `statement_timeout` in milliseconds (not set by default). */
  statementTimeoutMs?: number;
  /** Custom error logger for pool errors (defaults to `console.error`). */
  logger?: { error: (msg: string, err: Error) => void };
}

/** Creates a PostgreSQL driver backed by `pg`. */
export function createPostgresDriver(options: PostgresDriverOptions): Driver {
  const connectionString = options.connectionString ?? options.url;
  const baseConfig = connectionString
    ? { connectionString }
    : {
        host: options.host ?? "localhost",
        port: options.port ?? 5432,
        database: options.database ?? "postgres",
        user: options.user,
        password: options.password,
      };

  const pool = new Pool({
    ...baseConfig,
    min: options.poolMin ?? 2,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    ssl: options.ssl,
  });

  const log = options.logger ?? { error: (msg: string, err: Error) => console.error(msg, err) };
  const { statementTimeoutMs } = options;

  pool.on("error", (err: Error) => {
    log.error("Unexpected error on idle PostgreSQL client", err);
  });

  function wrapError(e: unknown, sql: string): never {
    const err = e as { code?: string; detail?: string; message?: string };
    const parts = [
      `PG(${err.code ?? "?"})`,
      err.message,
      err.detail,
      `SQL: ${sql.slice(0, 200)}`,
    ].filter(Boolean);
    throw new Error(parts.join(" — "), { cause: e as Error });
  }

  function toExecuteResult(result: pg.QueryResult, sql: string): ExecuteResult {
    const rowCount = result.rowCount ?? 0;
    const firstRow = result.rows[0];
    const lastID = firstRow
      ? (firstRow["id"] ?? firstRow["lastval"] ?? Object.values(firstRow)[0])
      : undefined;
    return {
      rows: result.rows,
      lastID: typeof lastID === "number" ? lastID : undefined,
      changes: rowCount,
    };
    void sql; // used in wrapError only
  }

  async function runQuery(
    queryable: { query(sql: string, params: unknown[]): Promise<pg.QueryResult> },
    sql: string,
    params: unknown[] = [],
  ): Promise<ExecuteResult> {
    const bound = params.map(toBindable);
    try {
      const result = await queryable.query(sql, bound);
      return toExecuteResult(result, sql);
    } catch (e) {
      wrapError(e, sql);
    }
  }

  function makeConnection(client: PoolClient): Connection {
    return {
      dialect: postgresDialect,
      execute: (sql, params) => runQuery(client, sql, params),
      async release(): Promise<void> {
        client.release();
      },
    };
  }

  return {
    dialect: postgresDialect,

    execute: (sql, params) => runQuery(pool, sql, params),

    async connect(): Promise<Connection> {
      const client = await pool.connect();
      if (statementTimeoutMs) {
        await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
      }
      return makeConnection(client);
    },

    createTrx(conn: Connection, options?: TransactionOptions) {
      return new PostgresTrx(conn, options);
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
