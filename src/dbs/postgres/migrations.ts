/**
 * PostgreSQL migrations: diff and DDL generation.
 */

import type { Driver, DbColumnInfo, DiffAction, DialectImpl } from "../types.js";
import { postgresDialect } from "./dialect.js";
import { BaseMigrations } from "../base-migrations.js";

type AlterColumnAction = Extract<DiffAction, { kind: "alter_column" }>;

export class PostgresMigrations extends BaseMigrations {
  readonly dialect = "postgres" as const;
  protected readonly dialectImpl: DialectImpl = postgresDialect;

  async getDbTables(driver: Driver): Promise<string[]> {
    const rows = await driver
      .execute(
        `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != '_typhex_migrations'
    `,
      )
      .then((r) => r.rows);
    return (rows as Array<{ table_name: string }>).map((r) => r.table_name);
  }

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const rows = await driver
      .execute(
        `
      SELECT column_name as name, data_type as type,
             CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END as notnull,
             column_default as dflt_value,
             CASE WHEN column_name IN (
               SELECT kcu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
               WHERE tc.table_schema = 'public'
                 AND tc.table_name = $1
                 AND tc.constraint_type = 'PRIMARY KEY'
             ) THEN 1 ELSE 0 END as pk
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
        [table],
      )
      .then((r) => r.rows);
    return rows as DbColumnInfo[];
  }

  getTrackingTableDdl(): string {
    const esc = (n: string) => this.dialectImpl.escapeIdentifier(n);
    return `CREATE TABLE IF NOT EXISTS ${esc("_typhex_migrations")} (
  ${esc("id")} SERIAL PRIMARY KEY,
  ${esc("name")} TEXT NOT NULL UNIQUE,
  ${esc("applied_at")} TIMESTAMP NOT NULL DEFAULT NOW()
)`;
  }

  getRecordMigrationSql(): string {
    const esc = (n: string) => this.dialectImpl.escapeIdentifier(n);
    return `INSERT INTO ${esc("_typhex_migrations")} (${esc("name")}) VALUES ($1)`;
  }

  getDeleteMigrationSql(): string {
    const esc = (n: string) => this.dialectImpl.escapeIdentifier(n);
    return `DELETE FROM ${esc("_typhex_migrations")} WHERE ${esc("name")} = $1`;
  }

  protected alterColumnSql(action: AlterColumnAction, reverse: boolean): string {
    const esc = (n: string) => this.dialectImpl.escapeIdentifier(n);
    const table = esc(action.table);
    const column = esc(action.column);

    return action.changes.map((change) => {
      switch (change.kind) {
        case "type": {
          const type = reverse ? change.from : change.to;
          return `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type};`;
        }
        case "not_null":
        case "nullable": {
          const notNull = reverse ? change.from : change.to;
          const operation = notNull ? "SET NOT NULL" : "DROP NOT NULL";
          return `ALTER TABLE ${table} ALTER COLUMN ${column} ${operation};`;
        }
        case "default": {
          const value = reverse ? change.from : change.to;
          const operation = value == null ? "DROP DEFAULT" : `SET DEFAULT ${value}`;
          return `ALTER TABLE ${table} ALTER COLUMN ${column} ${operation};`;
        }
        case "primary_key":
          throw new Error(
            `Primary key change on ${action.table}.${action.column} requires a manual migration; ` +
              `Postgres ALTER TABLE cannot add or drop a PK in isolation.`,
          );
      }
    }).join("\n");
  }
}

export const postgresMigrations = new PostgresMigrations();
