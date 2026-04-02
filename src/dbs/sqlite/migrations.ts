/**
 * SQLite migrations: diff and DDL generation.
 */

import type { Driver, DbMigrations, DiffAction, DbColumnInfo, ColumnDef } from "../types.js";
import { getColumnDef } from "../types.js";
import { sqliteDialect } from "./dialect.js";
import type { RegisteredEntity } from "../../entity/global-driver.js";

function extractBaseType(def: string): string {
  const trimmed = def.trim().toLowerCase().replace(/\s+/g, " ");
  const withoutModifiers = trimmed.replace(/^(?:unsigned|signed)\s+/, "");
  const multiWord = withoutModifiers.match(
    /^(?:double\s+precision|character\s+varying|timestamp\s+with\s+time\s+zone|timestamp\s+without\s+time\s+zone)(?:\([^)]*\))?/
  );
  if (multiWord) return multiWord[0];
  const withParams = withoutModifiers.match(/^(\w+(?:\([^)]*\))?)/);
  return withParams ? withParams[1] : withoutModifiers.split(/\s/)[0] ?? trimmed;
}

export const sqliteMigrations: DbMigrations = {
  dialect: "sqlite",

  async getDbTables(driver: Driver): Promise<string[]> {
    const rows = await driver.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_typhex_migrations'`
    ).then(r => r.rows);
    return (rows as Array<{ name: string }>).map((r) => r.name);
  },

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const esc = sqliteDialect.escapeIdentifier(table);
    const rows = await driver.execute(`PRAGMA table_info(${esc})`).then(r => r.rows);
    return rows as DbColumnInfo[];
  },

  async diffSchema(
    driver: Driver,
    entities: readonly RegisteredEntity[]
  ): Promise<DiffAction[]> {
    const actions: DiffAction[] = [];
    const dbTables = new Set(await this.getDbTables(driver));
    const entityTables = new Map(
      entities.map((e) => [e.table._table, e.table._schema])
    );

    for (const [table, schema] of entityTables) {
      if (!dbTables.has(table)) {
        actions.push({ kind: "add_table", table, schema });
        continue;
      }

      const dbCols = await this.getDbColumns(driver, table);
      const dbColMap = new Map(dbCols.map((c) => [c.name, c]));
      const entityCols = new Set(Object.keys(schema));

      for (const [col, def] of Object.entries(schema)) {
        const defStr = getColumnDef(def, "sqlite");
        if (!dbColMap.has(col)) {
          actions.push({ kind: "add_column", table, column: col, definition: def });
        } else {
          const dbCol = dbColMap.get(col)!;
          const dbBaseType = extractBaseType(dbCol.type);
          const entityBaseType = extractBaseType(defStr);
          if (dbBaseType !== entityBaseType) {
            actions.push({
              kind: "alter_column",
              table,
              column: col,
              oldDef: dbCol.type,
              newDef: def,
            });
          }
        }
      }

      for (const dbCol of dbCols) {
        if (!entityCols.has(dbCol.name)) {
          actions.push({ kind: "drop_column", table, column: dbCol.name });
        }
      }
    }

    for (const dbTable of dbTables) {
      if (!entityTables.has(dbTable)) {
        actions.push({ kind: "drop_table", table: dbTable });
      }
    }

    return actions;
  },

  generateSql(action: DiffAction): string {
    const esc = sqliteDialect.escapeIdentifier.bind(sqliteDialect);
    switch (action.kind) {
      case "add_table": {
        const cols = Object.entries(action.schema).map(
          ([c, def]) =>
            `  ${esc(c)} ${sqliteDialect.toColumnDef(def)}`
        );
        return `CREATE TABLE ${esc(action.table)} (\n${cols.join(",\n")}\n);`;
      }
      case "drop_table":
        return `DROP TABLE IF EXISTS ${esc(action.table)};`;
      case "add_column":
        return `ALTER TABLE ${esc(action.table)} ADD COLUMN ${esc(action.column)} ${sqliteDialect.toColumnDef(action.definition)};`;
      case "drop_column":
        return `ALTER TABLE ${esc(action.table)} DROP COLUMN ${esc(action.column)};`;
      case "alter_column":
        return (
          `-- SQLite does not support ALTER COLUMN. Recreate the table to change column type.\n` +
          `-- Column "${action.column}" on "${action.table}": ${action.oldDef} → ${getColumnDef(action.newDef, "sqlite")}`
        );
    }
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
