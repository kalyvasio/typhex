/**
 * Db: connection manager. Sets the global default driver so all entities
 * resolve it automatically. Provides migrate(), validate(), and close().
 *
 * Also exposes the programmatic migration API: generateMigrations(),
 * runMigrations(), and migrationStatus().
 */

import type { Driver } from "../driver/types.js";
import { createDriver } from "../driver/factory.js";
import { getDialect } from "../dbs/index.js";
import {
  setDefaultDriver,
  getRegisteredEntities,
} from "../entity/global-driver.js";
import { generateMigrationFiles, writeMigrationFiles } from "../migration/generator.js";
import { runMigrations as runMig, migrationStatus as migStatus } from "../migration/runner.js";
import { parseFkDependencies, topoSort } from "../migration/topo-sort.js";
import type { MigrationFile } from "../migration/types.js";
import { loadConfig } from "../config/load-config.js";

export type DbOptions =
  | { driver: Driver; migrationsFolder?: string }
  | {
      dialect: "sqlite" | "postgres";
      database?: string;
      url?: string;
      migrationsFolder?: string;
    };

function isDriver(v: unknown): v is Driver {
  return (
    v != null &&
    typeof v === "object" &&
    "query" in v &&
    "run" in v &&
    "close" in v
  );
}

export class Db {
  private migrationsFolder: string;
  private driver: Driver;

  constructor(options: DbOptions | Driver) {
    const opts: DbOptions = isDriver(options)
      ? { driver: options, migrationsFolder: "./migrations" }
      : options;
    let driver: Driver;
    if ("driver" in opts) {
      driver = opts.driver;
      this.migrationsFolder = opts.migrationsFolder ?? "./migrations";
    } else {
      driver = createDriver({
        dialect: opts.dialect,
        database: opts.database,
        url: opts.url,
      });
      this.migrationsFolder = opts.migrationsFolder ?? "./migrations";
    }
    this.driver = driver;
    setDefaultDriver(driver);
  }

  /** Create Db from config file. Loads config and creates driver internally. */
  static async fromConfig(options?: { configPath?: string; cwd?: string }): Promise<Db> {
    const config = await loadConfig({
      configPath: options?.configPath,
      cwd: options?.cwd,
    });
    return new Db(config);
  }

  /** CREATE TABLE IF NOT EXISTS for all registered entities (ordered by FK deps). */
  async migrate(): Promise<void> {
    const dialect = getDialect(this.driver.dialect ?? "sqlite");
    const esc = dialect.escapeIdentifier.bind(dialect);
    const entities = getRegisteredEntities();
    const deps = parseFkDependencies(entities);
    const names = entities.map((e) => e.table._table);
    const sorted = topoSort(names, deps);
    const byName = new Map(entities.map((e) => [e.table._table, e]));

    for (const name of sorted) {
      const entity = byName.get(name);
      if (!entity) continue;
      const { _schema: schema } = entity.table;
      const colDefs = Object.entries(schema)
        .map(([c, def]) => `${esc(c)} ${def}`)
        .join(", ");
      await this.driver.run(`CREATE TABLE IF NOT EXISTS ${esc(name)} (${colDefs})`);
    }
  }

  /** Validate all registered entities against the database. Throws on mismatch. */
  async validate(): Promise<void> {
    const dialect = getDialect(this.driver.dialect ?? "sqlite");
    const esc = dialect.escapeIdentifier.bind(dialect);
    for (const entity of getRegisteredEntities()) {
      const { _table: name, _schema: schema } = entity.table;
      const expectedCols = Object.keys(schema);

      const rows = (await this.driver.query(`PRAGMA table_info(${esc(name)})`)) as Array<{
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

  /**
   * Diff entity definitions against the database and generate migration files.
   * Returns the generated files (also written to disk).
   * Uses driver.dialect for SQL generation.
   */
  async generateMigrations(dir = this.migrationsFolder): Promise<MigrationFile[]> {
    const entities = getRegisteredEntities();
    const files = await generateMigrationFiles(this.driver, entities);
    if (files.length > 0) writeMigrationFiles(dir, files);
    return files;
  }

  /** Apply pending migration scripts from the migrations directory. */
  async runMigrations(dir = this.migrationsFolder) {
    return runMig(this.driver, dir);
  }

  /** Show applied and pending migration status. */
  async migrationStatus(dir = this.migrationsFolder) {
    return migStatus(this.driver, dir);
  }

  getDriver(): Driver {
    return this.driver;
  }

  async transaction<T>(
    fn: () => Promise<T>,
    options?: import("../driver/types.js").TransactionOptions
  ): Promise<T> {
    return this.driver.transaction(fn, options);
  }

  async close(): Promise<void> {
    setDefaultDriver(null);
    await this.driver.close();
  }
}
