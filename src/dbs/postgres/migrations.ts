/**
 * PostgreSQL migrations: diff and DDL generation.
 */

import type { Driver, DbColumnInfo } from "../types.js";
import { BaseMigrations } from "../base-migrations.js";
import { postgresDialect } from "./dialect.js";

export class PostgresMigrations extends BaseMigrations {
  readonly dialect = postgresDialect;

  async getDbTables(driver: Driver): Promise<string[]> {
    const compiled = this.dialect.queryCompiler.compileListTables();
    const rows = await driver.execute(compiled.sql, compiled.params).then((r) => r.rows);
    return (rows as Array<{ table_name: string }>).map((r) => r.table_name);
  }

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const compiled = this.dialect.queryCompiler.compileListColumns(table);
    const rows = await driver.execute(compiled.sql, compiled.params).then((r) => r.rows);
    return rows as DbColumnInfo[];
  }
}

export const postgresMigrations = new PostgresMigrations();
