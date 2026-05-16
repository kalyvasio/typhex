/**
 * SQLite migrations: diff and DDL generation.
 */

import type { Driver, DbColumnInfo } from "../types.js";
import { sqliteQueryCompiler } from "./query-compiler.js";
import { BaseMigrations } from "../base-migrations.js";

export class SqliteMigrations extends BaseMigrations {
  readonly dialect = "sqlite" as const;
  protected readonly compiler = sqliteQueryCompiler;

  async getDbTables(driver: Driver): Promise<string[]> {
    const compiled = this.compiler.compileListTables();
    const rows = await driver.execute(compiled.sql, compiled.params).then((r) => r.rows);
    return (rows as Array<{ name: string }>).map((r) => r.name);
  }

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const compiled = this.compiler.compileListColumns(table);
    const rows = await driver.execute(compiled.sql, compiled.params).then((r) => r.rows);
    return rows as DbColumnInfo[];
  }
}

export const sqliteMigrations = new SqliteMigrations();
