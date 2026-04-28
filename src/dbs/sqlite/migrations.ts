/**
 * SQLite migrations: diff and DDL generation.
 */

import type { Driver, DiffAction, DbColumnInfo, DialectImpl } from "../types.js";
import { sqliteDialect } from "./dialect.js";
import { BaseMigrations } from "../base-migrations.js";

type AlterColumnAction = Extract<DiffAction, { kind: "alter_column" }>;

export class SqliteMigrations extends BaseMigrations {
  readonly dialect = "sqlite" as const;
  protected readonly dialectImpl: DialectImpl = sqliteDialect;

  async getDbTables(driver: Driver): Promise<string[]> {
    const rows = await driver
      .execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_typhex_migrations'`,
      )
      .then((r) => r.rows);
    return (rows as Array<{ name: string }>).map((r) => r.name);
  }

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const esc = this.dialectImpl.escapeIdentifier(table);
    const rows = await driver.execute(`PRAGMA table_info(${esc})`).then((r) => r.rows);
    return rows as DbColumnInfo[];
  }

  getTrackingTableDdl(): string {
    const esc = (n: string) => this.dialectImpl.escapeIdentifier(n);
    return `CREATE TABLE IF NOT EXISTS ${esc("_typhex_migrations")} (
  ${esc("id")} integer primary key autoincrement,
  ${esc("name")} text not null unique,
  ${esc("applied_at")} text not null default (datetime('now'))
)`;
  }

  getRecordMigrationSql(): string {
    const esc = (n: string) => this.dialectImpl.escapeIdentifier(n);
    return `INSERT INTO ${esc("_typhex_migrations")} (${esc("name")}) VALUES (?)`;
  }

  getDeleteMigrationSql(): string {
    const esc = (n: string) => this.dialectImpl.escapeIdentifier(n);
    return `DELETE FROM ${esc("_typhex_migrations")} WHERE ${esc("name")} = ?`;
  }

  protected alterColumnSql(action: AlterColumnAction, reverse: boolean): never {
    const dimensions = action.changes.map((c) => c.kind).join(", ");
    const direction = reverse ? "rollback" : "apply";
    throw new Error(
      `SQLite cannot ${direction} ALTER COLUMN on ${action.table}.${action.column} ` +
        `(changes: ${dimensions}). The table must be recreated; please write the migration manually.`,
    );
  }
}

export const sqliteMigrations = new SqliteMigrations();
