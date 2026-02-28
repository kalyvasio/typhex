/**
 * Migration runner: reads .sql files from the migrations directory,
 * skips already-applied ones, executes pending ones in filename order,
 * and records each in the _typhex_migrations tracking table.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "../driver/types.js";
import type { MigrationRecord } from "./types.js";

const TRACKING_TABLE = "_typhex_migrations";

function ensureTrackingTable(driver: Driver): void {
  driver.run(`
    CREATE TABLE IF NOT EXISTS "${TRACKING_TABLE}" (
      "id" integer primary key autoincrement,
      "name" text not null unique,
      "applied_at" text not null default (datetime('now'))
    )
  `);
}

function getApplied(driver: Driver): Set<string> {
  ensureTrackingTable(driver);
  const rows = driver.query(
    `SELECT "name" FROM "${TRACKING_TABLE}" ORDER BY "id"`
  ) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function record(driver: Driver, name: string): void {
  driver.run(
    `INSERT INTO "${TRACKING_TABLE}" ("name") VALUES (?)`,
    [name]
  );
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function runMigrations(driver: Driver, dir: string): MigrationResult {
  ensureTrackingTable(driver);
  const applied = getApplied(driver);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const result: MigrationResult = { applied: [], skipped: [] };

  driver.transaction(() => {
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
        driver.run(stmt);
      }
      record(driver, name);
      result.applied.push(name);
    }
  });

  return result;
}

export function migrationStatus(
  driver: Driver,
  dir: string
): { applied: MigrationRecord[]; pending: string[] } {
  ensureTrackingTable(driver);
  const appliedRows = driver.query(
    `SELECT "id", "name", "applied_at" FROM "${TRACKING_TABLE}" ORDER BY "id"`
  ) as MigrationRecord[];
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

  const pending = files
    .map((f) => f.replace(/\.sql$/, ""))
    .filter((n) => !appliedNames.has(n));

  return { applied: appliedRows, pending };
}

function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"))
    .map((s) => s + ";");
}
