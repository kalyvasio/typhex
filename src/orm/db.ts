/**
 * Db: connection manager. Sets the global default driver so all entities
 * resolve it automatically. Provides migrate(), validate(), and close().
 */

import type { Driver } from "../driver/types.js";
import {
  setDefaultDriver,
  getRegisteredEntities,
} from "../entity/global-driver.js";

export class Db {
  constructor(private driver: Driver) {
    setDefaultDriver(driver);
  }

  /** CREATE TABLE IF NOT EXISTS for all registered entities. */
  migrate(): void {
    for (const entity of getRegisteredEntities()) {
      const { _table: name, _schema: schema } = entity.table;
      const colDefs = Object.entries(schema)
        .map(([c, def]) => `"${c}" ${def}`)
        .join(", ");
      this.driver.run(`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs})`);
    }
  }

  /** Validate all registered entities against the database. Throws on mismatch. */
  validate(): void {
    for (const entity of getRegisteredEntities()) {
      const { _table: name, _schema: schema } = entity.table;
      const expectedCols = Object.keys(schema);

      const rows = this.driver.query(`PRAGMA table_info("${name}")`) as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;

      if (rows.length === 0) {
        throw new Error(`validate: table "${name}" does not exist in the database.`);
      }

      const dbCols = new Map(rows.map((r) => [r.name, r]));

      for (const col of expectedCols) {
        if (!dbCols.has(col)) {
          throw new Error(
            `validate: column "${col}" is defined in Entity("${name}") but does not exist in the table.`
          );
        }
      }
    }
  }

  getDriver(): Driver {
    return this.driver;
  }

  close(): void {
    setDefaultDriver(null);
    this.driver.close();
  }
}
