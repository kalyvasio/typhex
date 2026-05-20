/**
 * Migration generator: takes DiffActions, groups them by table, orders them
 * topologically, and writes timestamped .js files with up() and down() functions.
 * Uses the dialect migrator for diff and the query compiler for SQL generation.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "../driver/types.js";
import type { DiffAction, MigrationFile } from "./types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";
import { parseFkDependencies, topoSort } from "./topo-sort.js";
import { groupBy } from "../utils.js";

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

function escapeTemplateLiteralContent(value: string): string {
  return value.replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function renderMigrationFile(upSql: string, downSql: string): string {
  return `export const upSql = \`${escapeTemplateLiteralContent(upSql)}\`;

export const downSql = \`${escapeTemplateLiteralContent(downSql)}\`;

export async function up(db) {
  await db.run(upSql);
}

export async function down(db) {
  await db.run(downSql);
}
`;
}

interface GroupedActions {
  table: string;
  actions: DiffAction[];
}

function groupByTable(actions: DiffAction[]): GroupedActions[] {
  return [...groupBy(actions, (a) => a.table)].map(([table, actions]) => ({ table, actions }));
}

/** Generates SQL migration files from entity definitions compared to the live database schema. */
export async function generateMigrationFiles(
  driver: Driver,
  entities: readonly RegisteredEntity[],
): Promise<MigrationFile[]> {
  const compiler = driver.dialect.queryCompiler;
  const actions = await driver.dialect.migrator.diffSchema(driver, entities);
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
    for (const action of group.actions) {
      const upSql = compiler.compileMigrationUp(action);
      const downSql = compiler.compileMigrationDown(action);
      files.push({
        name: scriptName(ts, seq, action),
        upSql,
        downSql,
        content: renderMigrationFile(upSql, downSql),
      });
      seq++;
    }
  }

  return files;
}

export function writeMigrationFiles(dir: string, files: MigrationFile[]): string[] {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const f of files) {
    const filePath = join(dir, `${f.name}.js`);
    writeFileSync(filePath, f.content, "utf-8");
    paths.push(filePath);
  }
  return paths;
}
