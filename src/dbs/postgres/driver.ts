/**
 * PostgreSQL driver using pg.
 */

import pg from "pg";
import type { Driver, TransactionOptions } from "../types.js";

const { Client } = pg;

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

function bindableParams(params: unknown[]): unknown[] {
  return params.map(toBindable);
}

export interface PostgresDriverOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export function createPostgresDriver(options: PostgresDriverOptions): Driver {
  const config = options.connectionString
    ? { connectionString: options.connectionString }
    : {
        host: options.host ?? "localhost",
        port: options.port ?? 5432,
        database: options.database ?? "postgres",
        user: options.user,
        password: options.password,
      };

  const client = new Client(config);

  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (!connected) {
      await client.connect();
      connected = true;
    }
  }

  return {
    dialect: "postgres",

    async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
      await ensureConnected();
      const result = await client.query(sql, bindableParams(params));
      return result.rows;
    },

    async run(sql: string, params: unknown[] = []): Promise<{ lastID?: number; changes: number }> {
      await ensureConnected();
      const result = await client.query(sql, bindableParams(params));
      const rowCount = result.rowCount ?? 0;
      const firstRow = result.rows[0];
      const lastID = firstRow
        ? (firstRow["id"] ?? firstRow["lastval"] ?? Object.values(firstRow)[0])
        : undefined;
      return {
        lastID: typeof lastID === "number" ? lastID : undefined,
        changes: rowCount,
      };
    },

    async transaction<T>(fn: () => Promise<T>, options?: TransactionOptions): Promise<T> {
      await ensureConnected();
      const isolationClause = options?.isolationLevel
        ? ` ISOLATION LEVEL ${options.isolationLevel.replace("_", " ")}`
        : "";
      await client.query(`BEGIN${isolationClause}`);
      try {
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    },

    async close(): Promise<void> {
      if (connected) {
        await client.end();
        connected = false;
      }
    },
  };
}
