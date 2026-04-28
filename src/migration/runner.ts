/**
 * Migration runner: discovers .js/.mjs migration files, skips already-applied ones,
 * executes pending ones in filename order by calling their exported up(db) function,
 * and records each in the _typhex_migrations tracking table.
 * downMigration calls the exported down(db) function and removes the tracking record.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as acorn from "acorn";
import type { Driver, Connection } from "../driver/types.js";
import type { MigrationDb, MigrationRecord, PendingMigration } from "./types.js";
import { getDbMigrations } from "../dbs/index.js";

interface MigrationModule {
  upSql: string;
  downSql: string;
  up: (db: MigrationDb) => Promise<void>;
  down: (db: MigrationDb) => Promise<void>;
}

class ConnectionMigrationDb implements MigrationDb {
  constructor(private conn: Connection) {}
  async run(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length > 0) {
      await this.conn.execute(sql, params);
      return;
    }
    for (const statement of splitSqlStatements(sql)) {
      await this.conn.execute(statement, []);
    }
  }
}

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

async function getAppliedRows(driver: Driver): Promise<MigrationRecord[]> {
  await ensureTrackingTable(driver);
  const esc = (n: string) => `"${n.replaceAll('"', '""')}"`;
  const table = esc("_typhex_migrations");
  return (await driver
    .execute(
      `SELECT ${esc("id")}, ${esc("name")}, ${esc("applied_at")} FROM ${table} ORDER BY ${esc("id")}`,
    )
    .then((r) => r.rows)) as MigrationRecord[];
}

function listMigrationFiles(dir: string): string[] {
  try {
    const names = new Set<string>();
    const files: string[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
      const name = stripExtension(file);
      if (names.has(name)) continue;
      names.add(name);
      files.push(file);
    }
    return files;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    return [];
  }
}

function stripExtension(file: string): string {
  return file.replace(/\.(m?js)$/, "");
}

async function loadModule(dir: string, file: string): Promise<MigrationModule> {
  const url = pathToFileURL(join(dir, file)).href;
  return import(url) as Promise<MigrationModule>;
}

function readMigrationSql(dir: string, file: string): Pick<MigrationModule, "upSql" | "downSql"> {
  const source = readFileSync(join(dir, file), "utf-8");
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  }) as acorn.Node & { body: unknown[] };
  const values = new Map<string, string>();

  for (const node of ast.body) {
    if (!isRecord(node) || node.type !== "ExportNamedDeclaration") continue;
    const declaration = node.declaration;
    if (!isRecord(declaration) || declaration.type !== "VariableDeclaration") continue;
    if (!Array.isArray(declaration.declarations)) continue;

    for (const declarator of declaration.declarations) {
      if (!isRecord(declarator)) continue;
      const name = identifierName(declarator.id);
      if (name !== "upSql" && name !== "downSql") continue;
      values.set(name, readStaticStringExport(file, name, declarator.init));
    }
  }

  const upSql = values.get("upSql");
  const downSql = values.get("downSql");
  if (upSql == null || downSql == null) {
    throw new Error(`Migration "${file}" must export static string upSql and downSql values.`);
  }
  return { upSql, downSql };
}

function identifierName(node: unknown): string | null {
  if (!isRecord(node) || node.type !== "Identifier" || typeof node.name !== "string") {
    return null;
  }
  return node.name;
}

function readStaticStringExport(file: string, name: string, node: unknown): string {
  if (isRecord(node) && node.type === "Literal" && typeof node.value === "string")
    return node.value;

  if (isRecord(node) && node.type === "TemplateLiteral") {
    const expressions = node.expressions;
    const quasis = node.quasis;
    if (
      Array.isArray(expressions) &&
      expressions.length === 0 &&
      Array.isArray(quasis) &&
      quasis.length === 1
    ) {
      const quasi = quasis[0];
      if (isRecord(quasi) && isRecord(quasi.value) && typeof quasi.value.cooked === "string") {
        return quasi.value.cooked;
      }
    }
  }

  throw new Error(`Migration "${file}" export "${name}" must be a static string literal.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

async function runInTransaction(
  conn: Connection,
  fn: (db: MigrationDb) => Promise<void>,
): Promise<void> {
  const db = new ConnectionMigrationDb(conn);
  await conn.execute("BEGIN", []);
  try {
    await fn(db);
    await conn.execute("COMMIT", []);
  } catch (e) {
    try {
      await conn.execute("ROLLBACK", []);
    } catch {
      /* ignore */
    }
    throw e;
  }
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
  const files = listMigrationFiles(dir);
  const result: MigrationResult = { applied: [], skipped: [] };

  const conn = await driver.connect();
  try {
    await conn.execute("BEGIN", []);
    const db = new ConnectionMigrationDb(conn);
    for (const file of files) {
      const name = stripExtension(file);
      if (applied.has(name)) {
        result.skipped.push(name);
        continue;
      }
      const mod = await loadModule(dir, file);
      await mod.up(db);
      await conn.execute(getDbMigrations(driver.dialect).getRecordMigrationSql(), [name]);
      applied.add(name);
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
  const appliedRows = await getAppliedRows(driver);
  const appliedNames = new Set(appliedRows.map((r) => r.name));
  const files = listMigrationFiles(dir);

  const pending = files.map(stripExtension).filter((n) => !appliedNames.has(n));

  return { applied: appliedRows, pending };
}

export async function appliedMigrations(driver: Driver): Promise<MigrationRecord[]> {
  return getAppliedRows(driver);
}

export async function pendingMigrations(driver: Driver, dir: string): Promise<PendingMigration[]> {
  const appliedRows = await getAppliedRows(driver);
  const appliedNames = new Set(appliedRows.map((r) => r.name));
  const pending: PendingMigration[] = [];
  for (const file of listMigrationFiles(dir)) {
    const name = stripExtension(file);
    if (appliedNames.has(name)) continue;
    const mod = readMigrationSql(dir, file);
    pending.push({
      name,
      file,
      upSql: mod.upSql,
      downSql: mod.downSql,
      statements: splitSqlStatements(mod.upSql),
      downStatements: splitSqlStatements(mod.downSql),
    });
  }
  return pending;
}

export async function dryRunMigrations(
  driver: Driver,
  dir: string,
): Promise<{ applied: MigrationRecord[]; pending: PendingMigration[]; skipped: string[] }> {
  const applied = await getAppliedRows(driver);
  const appliedNames = new Set(applied.map((r) => r.name));
  const pending: PendingMigration[] = [];
  const skipped: string[] = [];

  for (const file of listMigrationFiles(dir)) {
    const name = stripExtension(file);
    if (appliedNames.has(name)) {
      skipped.push(name);
      continue;
    }
    const mod = readMigrationSql(dir, file);
    pending.push({
      name,
      file,
      upSql: mod.upSql,
      downSql: mod.downSql,
      statements: splitSqlStatements(mod.upSql),
      downStatements: splitSqlStatements(mod.downSql),
    });
  }

  return { applied, pending, skipped };
}

export async function upMigration(driver: Driver, dir: string, name: string): Promise<void> {
  const applied = await getApplied(driver);
  if (applied.has(name)) {
    throw new Error(`Migration "${name}" is already applied.`);
  }
  const file = findMigrationFile(dir, name);
  if (!file) {
    throw new Error(`Migration file for "${name}" not found in "${dir}".`);
  }
  const mod = await loadModule(dir, file);
  const conn = await driver.connect();
  try {
    await runInTransaction(conn, async (db) => {
      await mod.up(db);
      await conn.execute(getDbMigrations(driver.dialect).getRecordMigrationSql(), [name]);
    });
  } finally {
    await conn.release();
  }
}

export async function downMigration(driver: Driver, dir: string, name: string): Promise<void> {
  const applied = await getApplied(driver);
  if (!applied.has(name)) {
    throw new Error(`Migration "${name}" is not applied.`);
  }
  const file = findMigrationFile(dir, name);
  if (!file) {
    throw new Error(`Migration file for "${name}" not found in "${dir}".`);
  }
  const mod = await loadModule(dir, file);
  const conn = await driver.connect();
  try {
    await runInTransaction(conn, async (db) => {
      await mod.down(db);
      await conn.execute(getDbMigrations(driver.dialect).getDeleteMigrationSql(), [name]);
    });
  } finally {
    await conn.release();
  }
}

function findMigrationFile(dir: string, name: string): string | null {
  for (const ext of [".js", ".mjs"]) {
    const file = `${name}${ext}`;
    try {
      const files = readdirSync(dir);
      if (files.includes(file)) return file;
    } catch {
      return null;
    }
  }
  return null;
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isCommentOnlySql(s));
}

function isCommentOnlySql(sql: string): boolean {
  return sql.split("\n").every((line) => line.trim() === "" || line.trim().startsWith("--"));
}
