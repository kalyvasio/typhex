/**
 * PostgreSQL migrations: diff and DDL generation.
 */

import type { Driver, DbMigrations, DiffAction, DbColumnInfo } from "../types.js";
import { getColumnDef } from "../types.js";
import { postgresDialect } from "./dialect.js";
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

export const postgresMigrations: DbMigrations = {
  dialect: "postgres",

  async getDbTables(driver: Driver): Promise<string[]> {
    const rows = await driver.execute(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != '_typhex_migrations'
    `).then(r => r.rows);
    return (rows as Array<{ table_name: string }>).map((r) => r.table_name);
  },

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const rows = await driver.execute(
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
      [table]
    ).then(r => r.rows);
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
        const defStr = getColumnDef(def, "postgres");
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
    const esc = postgresDialect.escapeIdentifier.bind(postgresDialect);
    switch (action.kind) {
      case "add_table": {
        const cols = Object.entries(action.schema).map(
          ([c, def]) =>
            `  ${esc(c)} ${postgresDialect.toColumnDef(def)}`
        );
        return `CREATE TABLE ${esc(action.table)} (\n${cols.join(",\n")}\n);`;
      }
      case "drop_table":
        return `DROP TABLE IF EXISTS ${esc(action.table)};`;
      case "add_column":
        return `ALTER TABLE ${esc(action.table)} ADD COLUMN ${esc(action.column)} ${postgresDialect.toColumnDef(action.definition)};`;
      case "drop_column":
        return `ALTER TABLE ${esc(action.table)} DROP COLUMN ${esc(action.column)};`;
      case "alter_column":
        return `ALTER TABLE ${esc(action.table)} ALTER COLUMN ${esc(action.column)} TYPE ${getColumnDef(action.newDef, "postgres")};`;
    }
  },

  getTrackingTableDdl(): string {
    const esc = postgresDialect.escapeIdentifier.bind(postgresDialect);
    return `CREATE TABLE IF NOT EXISTS ${esc("_typhex_migrations")} (
  ${esc("id")} SERIAL PRIMARY KEY,
  ${esc("name")} TEXT NOT NULL UNIQUE,
  ${esc("applied_at")} TIMESTAMP NOT NULL DEFAULT NOW()
)`;
  },

  getRecordMigrationSql(): string {
    const esc = postgresDialect.escapeIdentifier.bind(postgresDialect);
    return `INSERT INTO ${esc("_typhex_migrations")} (${esc("name")}) VALUES ($1)`;
  },
};
