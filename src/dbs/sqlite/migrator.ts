/**
 * SQLite schema migrator: diff and introspection.
 */

import type { DbColumnInfo } from "../types.js";
import type { ResolvedDriver } from "../../driver/types.js";
import { BaseMigrator } from "../base-migrator.js";
import { sqliteQueryCompiler } from "./query-compiler.js";

export class SqliteMigrator extends BaseMigrator {
  constructor() {
    super("sqlite", sqliteQueryCompiler);
  }

  async getDbTables(driver: ResolvedDriver): Promise<string[]> {
    const compiled = this.queryCompiler.compileListTables();
    const rows = await driver.execute(compiled.sql, compiled.params).then((r) => r.rows);
    return (rows as Array<{ name: string }>).map((r) => r.name);
  }

  async getDbColumns(driver: ResolvedDriver, table: string): Promise<DbColumnInfo[]> {
    const compiled = this.queryCompiler.compileListColumns(table);
    const rows = await driver.execute(compiled.sql, compiled.params).then((r) => r.rows);
    return rows as DbColumnInfo[];
  }
}

export const sqliteMigrator = new SqliteMigrator();
