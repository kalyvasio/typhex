/**
 * PostgreSQL driver using pg.Pool.
 * Thin adapter: execute(), connect(), close() only — no transaction logic.
 */

import pg from "pg";
import type { Driver, Connection, ExecuteResult, TransactionOptions } from "../../driver/types.js";
import {PostgresTrx} from "./trx.js";
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

export interface PostgresDriverOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: pg.ConnectionConfig["ssl"];
  poolMin?: number;
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  logger?: { error: (msg: string, err: Error) => void };
}

export function createPostgresDriver(options: PostgresDriverOptions): Driver {
  const baseConfig = options.connectionString
    ? { connectionString: options.connectionString }
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
    params: unknown[] = []
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
      dialect: "postgres" as const,
      execute: (sql, params) => runQuery(client, sql, params),
      async release(): Promise<void> {
        client.release();
      },
    };
  }

  return {
    dialect: "postgres",

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
