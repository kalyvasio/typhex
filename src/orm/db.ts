/**
 * Database: driver + table registry + migrations.
 */

import type { Driver } from "../driver/types.js";
import type { TableDefinition } from "../schema/types.js";
import { getColumnNames, sqlType } from "../schema/types.js";
import { Table } from "./table.js";

export class Db {
  private tables = new Map<string, Table<Record<string, unknown>>>();

  constructor(private driver: Driver) {}

  defineTable<T = Record<string, unknown>>(
    tableName: string,
    definition: TableDefinition
  ): Table<T> {
    const table = new Table<T>(tableName, definition, this.driver);
    this.tables.set(tableName, table as Table<Record<string, unknown>>);
    return table;
  }

  table<T = Record<string, unknown>>(tableName: string): Table<T> {
    const t = this.tables.get(tableName);
    if (!t) throw new Error(`Table not defined: ${tableName}`);
    return t as Table<T>;
  }

  /** Create table if not exists (simple migration). */
  migrate(): void {
    for (const [name, table] of this.tables) {
      const cols = getColumnNames(table.definition);
      const defs = cols.map((c) => `"${c}" ${sqlType(table.definition, c)}`).join(", ");
      const sql = `CREATE TABLE IF NOT EXISTS "${name}" (${defs})`;
      this.driver.run(sql);
    }
  }

  close(): void {
    this.driver.close();
  }
}
