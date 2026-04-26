/**
 * SQLite migrations: diff and DDL generation.
 */

import type { Driver, DbMigrations, DiffAction, DbColumnInfo } from "../types.js";
import { getColumnDef } from "../types.js";
import { sqliteDialect } from "./dialect.js";
import type { RegisteredEntity } from "../../entity/global-driver.js";
import { diffSchemaBase, generateCommonSql } from "../shared-migrations.js";

export const sqliteMigrations: DbMigrations = {
  dialect: "sqlite",

  async getDbTables(driver: Driver): Promise<string[]> {
    const rows = await driver
      .execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_typhex_migrations'`,
      )
      .then((r) => r.rows);
    return (rows as Array<{ name: string }>).map((r) => r.name);
  },

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const esc = sqliteDialect.escapeIdentifier(table);
    const rows = await driver.execute(`PRAGMA table_info(${esc})`).then((r) => r.rows);
    return rows as DbColumnInfo[];
  },

  async diffSchema(driver: Driver, entities: readonly RegisteredEntity[]): Promise<DiffAction[]> {
    return diffSchemaBase(
      "sqlite",
      () => this.getDbTables(driver),
      (table) => this.getDbColumns(driver, table),
      entities,
    );
  },

  generateSql(action: DiffAction): string {
    const shared = generateCommonSql(action, sqliteDialect);
    if (shared !== null) return shared;
    // alter_column: SQLite does not support it natively
    const a = action as Extract<DiffAction, { kind: "alter_column" }>;
    return (
      `-- SQLite does not support ALTER COLUMN. Recreate the table to change column type.\n` +
      `-- Column "${a.column}" on "${a.table}": ${a.oldDef} → ${getColumnDef(a.newDef, "sqlite")}`
    );
  },

  getTrackingTableDdl(): string {
    const esc = sqliteDialect.escapeIdentifier.bind(sqliteDialect);
    return `CREATE TABLE IF NOT EXISTS ${esc("_typhex_migrations")} (
  ${esc("id")} integer primary key autoincrement,
  ${esc("name")} text not null unique,
  ${esc("applied_at")} text not null default (datetime('now'))
)`;
  },

  getRecordMigrationSql(): string {
    const esc = sqliteDialect.escapeIdentifier.bind(sqliteDialect);
    return `INSERT INTO ${esc("_typhex_migrations")} (${esc("name")}) VALUES (?)`;
  },
};
