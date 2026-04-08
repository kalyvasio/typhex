/**
 * Shared migration utilities used by both SQLite and Postgres dialects.
 */

import type { Driver, DbMigrations, DiffAction, DbColumnInfo, DialectImpl } from "./types.js";
import { getColumnDef } from "./types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";

export function extractBaseType(def: string): string {
  const trimmed = def.trim().toLowerCase().replace(/\s+/g, " ");
  const withoutModifiers = trimmed.replace(/^(?:unsigned|signed)\s+/, "");
  const multiWord = withoutModifiers.match(
    /^(?:double\s+precision|character\s+varying|timestamp\s+with\s+time\s+zone|timestamp\s+without\s+time\s+zone)(?:\([^)]*\))?/
  );
  if (multiWord) return multiWord[0];
  const withParams = withoutModifiers.match(/^(\w+(?:\([^)]*\))?)/);
  return withParams ? withParams[1] : withoutModifiers.split(/\s/)[0] ?? trimmed;
}

export async function diffSchemaBase(
  dialect: "sqlite" | "postgres",
  getDbTables: () => Promise<string[]>,
  getDbColumns: (table: string) => Promise<DbColumnInfo[]>,
  entities: readonly RegisteredEntity[]
): Promise<DiffAction[]> {
  const actions: DiffAction[] = [];
  const dbTables = new Set(await getDbTables());
  const entityTables = new Map(
    entities.map((e) => [e.table._table, e.table._schema])
  );

  for (const [table, schema] of entityTables) {
    if (!dbTables.has(table)) {
      actions.push({ kind: "add_table", table, schema });
      continue;
    }

    const dbCols = await getDbColumns(table);
    const dbColMap = new Map(dbCols.map((c) => [c.name, c]));
    const entityCols = new Set(Object.keys(schema));

    for (const [col, def] of Object.entries(schema)) {
      const defStr = getColumnDef(def, dialect);
      if (!dbColMap.has(col)) {
        actions.push({ kind: "add_column", table, column: col, definition: def });
      } else {
        const dbCol = dbColMap.get(col)!;
        const dbBaseType = extractBaseType(dbCol.type);
        const entityBaseType = extractBaseType(defStr);
        if (dbBaseType !== entityBaseType) {
          actions.push({ kind: "alter_column", table, column: col, oldDef: dbCol.type, newDef: def });
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
}

/** Generate SQL for the common DiffAction kinds (all except alter_column).
 *  Returns null for alter_column — each dialect handles that case differently. */
export function generateCommonSql(action: DiffAction, dialect: DialectImpl): string | null {
  const esc = dialect.escapeIdentifier.bind(dialect);
  switch (action.kind) {
    case "add_table": {
      const cols = Object.entries(action.schema).map(
        ([c, def]) => `  ${esc(c)} ${dialect.toColumnDef(def)}`
      );
      return `CREATE TABLE ${esc(action.table)} (\n${cols.join(",\n")}\n);`;
    }
    case "drop_table":
      return `DROP TABLE IF EXISTS ${esc(action.table)};`;
    case "add_column":
      return `ALTER TABLE ${esc(action.table)} ADD COLUMN ${esc(action.column)} ${dialect.toColumnDef(action.definition)};`;
    case "drop_column":
      return `ALTER TABLE ${esc(action.table)} DROP COLUMN ${esc(action.column)};`;
    default:
      return null;
  }
}
