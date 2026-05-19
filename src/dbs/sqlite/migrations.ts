/**
 * SQLite migrations: diff and DDL generation.
 */

import type { Driver, DbColumnInfo } from "../types.js";
import { BaseMigrations } from "../base-migrations.js";
import { sqliteDialect } from "./dialect.js";

export class SqliteMigrations extends BaseMigrations {
  readonly dialect = sqliteDialect;

  async getDbTables(driver: Driver): Promise<string[]> {
    const compiled = this.dialect.queryCompiler.compileListTables();
    const rows = await driver.execute(compiled.sql, compiled.params).then((r) => r.rows);
    return (rows as Array<{ name: string }>).map((r) => r.name);
  }

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const compiled = this.dialect.queryCompiler.compileListColumns(table);
    const rows = await driver.execute(compiled.sql, compiled.params).then((r) => r.rows);
    return rows as DbColumnInfo[];
  }
}

export const sqliteMigrations = new SqliteMigrations();
