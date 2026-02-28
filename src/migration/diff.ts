/**
 * Schema diff: compare registered entity definitions against the live database.
 * Produces a list of DiffActions grouped by table.
 */

import type { Driver } from "../driver/types.js";
import { escapeIdentifier } from "../compiler/sql.js";
import type { DbColumnInfo, DiffAction } from "./types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";

function normalizeType(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract base type from a column definition for comparison.
 * - Strips leading modifiers (unsigned, signed)
 * - Preserves type(params) e.g. varchar(255)
 * - Handles multi-word types e.g. double precision, character varying
 */
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

function getDbColumns(driver: Driver, table: string): DbColumnInfo[] {
  return driver.query(`PRAGMA table_info(${escapeIdentifier(table)})`) as DbColumnInfo[];
}

function getDbTables(driver: Driver): string[] {
  const rows = driver.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_typhex_migrations'`
  ) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function diffSchema(
  driver: Driver,
  entities: readonly RegisteredEntity[]
): DiffAction[] {
  const actions: DiffAction[] = [];
  const dbTables = new Set(getDbTables(driver));
  const entityTables = new Map(entities.map((e) => [e.table._table, e.table._schema]));

  for (const [table, schema] of entityTables) {
    if (!dbTables.has(table)) {
      actions.push({ kind: "add_table", table, schema });
      continue;
    }

    const dbCols = getDbColumns(driver, table);
    const dbColMap = new Map(dbCols.map((c) => [c.name, c]));
    const entityCols = new Set(Object.keys(schema));

    for (const [col, def] of Object.entries(schema)) {
      if (!dbColMap.has(col)) {
        actions.push({ kind: "add_column", table, column: col, definition: def });
      } else {
        const dbCol = dbColMap.get(col)!;
        const dbBaseType = extractBaseType(dbCol.type);
        const entityBaseType = extractBaseType(def);
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
}
