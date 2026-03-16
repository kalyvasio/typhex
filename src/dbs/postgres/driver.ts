/**
 * PostgreSQL driver using pg.Pool with AsyncLocalStorage for transaction routing.
 */

import pg from "pg";
import { AsyncLocalStorage } from "async_hooks";
import type { Driver } from "../types.js";

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
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return JSON.stringify(value);
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

  pool.on("error", (err: Error) => {
    console.error("Unexpected error on idle PostgreSQL client", err);
  });

  const transactionStorage = new AsyncLocalStorage<PoolClient>();

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

  return {
    dialect: "postgres",

    async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
      const client = transactionStorage.getStore();
      const bound = params.map(toBindable);
      try {
        const result = client
          ? await client.query(sql, bound)
          : await pool.query(sql, bound);
        return result.rows;
      } catch (e) {
        wrapError(e, sql);
      }
    },

    async run(sql: string, params: unknown[] = []): Promise<{ lastID?: number; changes: number }> {
      const client = transactionStorage.getStore();
      const bound = params.map(toBindable);
      try {
        const result = client
          ? await client.query(sql, bound)
          : await pool.query(sql, bound);
        const rowCount = result.rowCount ?? 0;
        const firstRow = result.rows[0];
        const lastID = firstRow
          ? (firstRow["id"] ?? firstRow["lastval"] ?? Object.values(firstRow)[0])
          : undefined;
        return { lastID: typeof lastID === "number" ? lastID : undefined, changes: rowCount };
      } catch (e) {
        wrapError(e, sql);
      }
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      const existingClient = transactionStorage.getStore();
      if (existingClient) {
        // Nested transaction: use savepoint
        const sp = `sp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await existingClient.query(`SAVEPOINT ${sp}`);
        try {
          const result = await fn();
          await existingClient.query(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (e) {
          await existingClient.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw e;
        }
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await transactionStorage.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* ignore rollback failure */ }
        throw e;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
