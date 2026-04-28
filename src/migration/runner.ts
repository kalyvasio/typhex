/**
 * Migration runner: reads .sql files from the migrations directory,
 * skips already-applied ones, executes pending ones in filename order,
 * and records each in the _typhex_migrations tracking table.
 * Uses dialect's DbMigrations for tracking table DDL and record SQL.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "../driver/types.js";
import type { MigrationRecord } from "./types.js";
import { getDbMigrations } from "../dbs/index.js";

async function ensureTrackingTable(driver: Driver): Promise<void> {
  const migrations = getDbMigrations(driver.dialect);
  await driver.execute(migrations.getTrackingTableDdl());
}

async function getApplied(driver: Driver): Promise<Set<string>> {
  await ensureTrackingTable(driver);
  const esc = (n: string) => `"${n.replaceAll('"', '""')}"`;
  const table = esc("_typhex_migrations");
  const rows = (await driver
    .execute(`SELECT ${esc("name")} FROM ${table} ORDER BY ${esc("id")}`)
    .then((r) => r.rows)) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** Result returned by `runMigrations`: lists of applied and skipped migration file names. */
export interface MigrationResult {
  /** Names of migration files that were applied in this run. */
  applied: string[];
  /** Names of migration files that were already applied and skipped. */
  skipped: string[];
}

/** Applies all pending migration files from `dir` in chronological order. */
export async function runMigrations(driver: Driver, dir: string): Promise<MigrationResult> {
  const applied = await getApplied(driver);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const result: MigrationResult = { applied: [], skipped: [] };

  const conn = await driver.connect();
  try {
    await conn.execute("BEGIN", []);
    for (const file of files) {
      const name = file.replace(/\.sql$/, "");
      if (applied.has(name)) {
        result.skipped.push(name);
        continue;
      }
      const sql = readFileSync(join(dir, file), "utf-8").trim();
      if (sql.startsWith("--")) {
        const hasRealSql = sql
          .split("\n")
          .some((line) => line.trim() !== "" && !line.trim().startsWith("--"));
        if (!hasRealSql) {
          result.skipped.push(name);
          continue;
        }
      }
      for (const stmt of splitStatements(sql)) {
        await conn.execute(stmt, []);
      }
      await conn.execute(getDbMigrations(driver.dialect).getRecordMigrationSql(), [name]);
      result.applied.push(name);
    }
    await conn.execute("COMMIT", []);
  } catch (e) {
    try {
      await conn.execute("ROLLBACK", []);
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    await conn.release();
  }

  return result;
}

/** Returns which migration files have been applied and which are pending. */
export async function migrationStatus(
  driver: Driver,
  dir: string,
): Promise<{ applied: MigrationRecord[]; pending: string[] }> {
  await ensureTrackingTable(driver);
  const esc = (n: string) => `"${n.replaceAll('"', '""')}"`;
  const table = esc("_typhex_migrations");
  const appliedRows = (await driver
    .execute(
      `SELECT ${esc("id")}, ${esc("name")}, ${esc("applied_at")} FROM ${table} ORDER BY ${esc("id")}`,
    )
    .then((r) => r.rows)) as MigrationRecord[];
  const appliedNames = new Set(appliedRows.map((r) => r.name));

  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    // ENOENT: dir doesn't exist yet, files stays []
  }

  const pending = files.map((f) => f.replace(/\.sql$/, "")).filter((n) => !appliedNames.has(n));

  return { applied: appliedRows, pending };
}

function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"))
    .map((s) => s + ";");
}
