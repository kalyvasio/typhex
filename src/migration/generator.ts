/**
 * Migration generator: takes DiffActions, groups them by table, orders them
 * topologically, and writes timestamped .sql files.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "../driver/types.js";
import { escapeIdentifier } from "../compiler/sql.js";
import type { Dialect } from "../dialect.js";
import type { DiffAction, MigrationFile } from "./types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";
import { diffSchema } from "./diff.js";
import { parseFkDependencies, topoSort } from "./topo-sort.js";

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

function scriptName(ts: string, seq: number, action: DiffAction): string {
  const seqStr = String(seq).padStart(2, "0");
  const base = `${ts}${seqStr}`;
  switch (action.kind) {
    case "add_table":
      return `${base}_add_${slugify(action.table)}_table`;
    case "drop_table":
      return `${base}_drop_${slugify(action.table)}_table`;
    case "add_column":
      return `${base}_add_${slugify(action.column)}_column_on_${slugify(action.table)}`;
    case "drop_column":
      return `${base}_drop_${slugify(action.column)}_column_on_${slugify(action.table)}`;
    case "alter_column":
      return `${base}_alter_${slugify(action.column)}_column_on_${slugify(action.table)}`;
  }
}

/** Transform SQLite column definition to PostgreSQL where applicable. */
function toPostgresDef(def: string): string {
  return def
    .replace(/\binteger\s+primary\s+key\s+autoincrement\b/gi, "SERIAL PRIMARY KEY")
    .replace(/\bbigint\s+primary\s+key\s+autoincrement\b/gi, "BIGSERIAL PRIMARY KEY");
}

/** Extract base type for PostgreSQL ALTER COLUMN TYPE. SERIAL maps to integer. */
function pgAlterType(newDef: string): string {
  const def = toPostgresDef(newDef);
  if (/^SERIAL\b/i.test(def)) return "integer";
  if (/^BIGSERIAL\b/i.test(def)) return "bigint";
  const m = def.match(/^(integer|bigint|text|varchar|boolean|real|numeric|timestamp|date)\b/i);
  return m ? m[1] : def.split(/\s/)[0] ?? def;
}

function generateSqlForDialect(action: DiffAction, dialect: Dialect): string {
  switch (action.kind) {
    case "add_table": {
      const cols = Object.entries(action.schema).map(([c, def]) => {
        const colDef = dialect === "postgres" ? toPostgresDef(def) : def;
        return `  ${escapeIdentifier(c)} ${colDef}`;
      });
      return `CREATE TABLE ${escapeIdentifier(action.table)} (\n${cols.join(",\n")}\n);`;
    }
    case "drop_table":
      return `DROP TABLE IF EXISTS ${escapeIdentifier(action.table)};`;
    case "add_column": {
      const def = dialect === "postgres" ? toPostgresDef(action.definition) : action.definition;
      return `ALTER TABLE ${escapeIdentifier(action.table)} ADD COLUMN ${escapeIdentifier(action.column)} ${def};`;
    }
    case "drop_column":
      if (dialect === "postgres") {
        return `ALTER TABLE ${escapeIdentifier(action.table)} DROP COLUMN IF EXISTS ${escapeIdentifier(action.column)};`;
      }
      return `ALTER TABLE ${escapeIdentifier(action.table)} DROP COLUMN ${escapeIdentifier(action.column)};`;
    case "alter_column":
      if (dialect === "postgres") {
        const pgType = pgAlterType(action.newDef);
        return `ALTER TABLE ${escapeIdentifier(action.table)} ALTER COLUMN ${escapeIdentifier(action.column)} TYPE ${pgType};`;
      }
      return (
        `-- SQLite does not support ALTER COLUMN. Recreate the table to change column type.\n` +
        `-- Column "${action.column}" on "${action.table}": ${action.oldDef} → ${action.newDef}`
      );
  }
}

interface GroupedActions {
  table: string;
  actions: DiffAction[];
}

function groupByTable(actions: DiffAction[]): GroupedActions[] {
  const map = new Map<string, DiffAction[]>();
  for (const a of actions) {
    const list = map.get(a.table) ?? [];
    list.push(a);
    map.set(a.table, list);
  }
  return Array.from(map.entries()).map(([table, actions]) => ({ table, actions }));
}

export function generateMigrationFiles(
  driver: Driver,
  entities: readonly RegisteredEntity[],
  dialect?: Dialect
): MigrationFile[] {
  const resolvedDialect = dialect ?? (driver.dialect ?? "sqlite");
  const actions = diffSchema(driver, entities);
  if (actions.length === 0) return [];

  const groups = groupByTable(actions);
  const deps = parseFkDependencies(entities);
  const allTables = groups.map((g) => g.table);
  const sorted = topoSort(allTables, deps);

  const sortedGroups = sorted
    .map((t) => groups.find((g) => g.table === t))
    .filter((g): g is GroupedActions => g != null);

  const ts = timestamp();
  const files: MigrationFile[] = [];
  let seq = 1;

  for (const group of sortedGroups) {
    if (group.actions.length === 1 && group.actions[0].kind === "add_table") {
      const action = group.actions[0];
      files.push({
        name: scriptName(ts, seq, action),
        sql: generateSqlForDialect(action, resolvedDialect),
      });
      seq++;
    } else {
      for (const action of group.actions) {
        files.push({
          name: scriptName(ts, seq, action),
          sql: generateSqlForDialect(action, resolvedDialect),
        });
        seq++;
      }
    }
  }

  return files;
}

export function writeMigrationFiles(dir: string, files: MigrationFile[]): string[] {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const f of files) {
    const filePath = join(dir, `${f.name}.sql`);
    writeFileSync(filePath, f.sql + "\n", "utf-8");
    paths.push(filePath);
  }
  return paths;
}
