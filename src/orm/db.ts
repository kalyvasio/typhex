/**
 * Db: the rich database class. Transaction logic lives in dialect-specific Trx subclasses
 * (see src/orm/trx.ts and dialect trx subclasses). Db.transaction() manages the connection
 * lifecycle and delegates to Driver.createTrx() for the dialect-specific scope.
 */

import type { Driver, TransactionOptions } from "../driver/types.js";
import type { Dialect, DialectName } from "../dbs/types.js";
import { createDriver, CreateDriverOptions } from "../driver/factory.js";
import { getRegisteredEntities, setDefaultDb } from "../entity/global-driver.js";
import { generateMigrationFiles, writeMigrationFiles } from "../migration/generator.js";
import {
  appliedMigrations as appliedMig,
  downMigration as downMig,
  dryRunMigrations as dryRunMig,
  migrationStatus as migStatus,
  pendingMigrations as pendingMig,
  runMigrations as runMig,
  upMigration as upMig,
} from "../migration/runner.js";
import { parseFkDependencies, topoSort } from "../migration/topo-sort.js";
import type { MigrationFile } from "../migration/types.js";
import { loadConfig } from "../config/load-config.js";
import { Trx, getActiveTrx, runInTrxStorage } from "./trx.js";
export { Trx, getActiveTrx };

/** Minimal interface satisfied by both `Db` and `Trx` — pass either as the executor for query builders. */
export interface QueryExecutor {
  /** The SQL dialect in use. */
  readonly dialect: Dialect;
  /** Runs a SQL query and returns all result rows. */
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  /** Executes a SQL statement and returns affected-row metadata. */
  run(sql: string, params?: unknown[]): Promise<{ lastID?: number; changes: number }>;
}

/** Options passed to the `Db` constructor: either a pre-built driver or dialect + connection details. */
export type DbOptions =
  | { driver: Driver; migrationsFolder?: string }
  | {
      dialect: DialectName;
      database?: string;
      url?: string;
      migrationsFolder?: string;
    };

function isDriver(v: unknown): v is Driver {
  return v != null && typeof v === "object" && "execute" in v && "connect" in v && "close" in v;
}

/** Internal symbol: only used for the Db internal constructor overload. */
const INTERNAL = Symbol("db-internal");

/** Root database class. Create via `new Db(options)` or `Db.fromConfig()`. */
export class Db implements QueryExecutor {
  /** @internal */
  protected _driver: Driver;
  private _migrationsFolder: string;

  constructor(options: DbOptions | Driver);
  /** @internal — Trx subclass only */
  constructor(driver: Driver, _internal: typeof INTERNAL);
  constructor(arg: Driver | DbOptions, internal?: typeof INTERNAL) {
    this._driver = isDriver(arg)
      ? arg
      : isDriver((arg as { driver?: unknown }).driver)
        ? (arg as { driver: Driver }).driver
        : createDriver(arg as CreateDriverOptions);
    this._migrationsFolder =
      (arg as { migrationsFolder?: string }).migrationsFolder ?? "./migrations";
    if (internal !== INTERNAL) setDefaultDb(this);
  }

  /** Create Db from config file. Loads config and creates driver internally. */
  static async fromConfig(options?: { configPath?: string; cwd?: string }): Promise<Db> {
    const config = await loadConfig({
      configPath: options?.configPath,
      cwd: options?.cwd,
    });
    return new Db(config);
  }

  /** The SQL dialect used by this `Db` instance. */
  get dialect(): Dialect {
    return this._driver.dialect;
  }

  /** The underlying database driver. */
  get driver(): Driver {
    return this._driver;
  }

  /** Runs a SQL query and returns all result rows. */
  query(sql: string, params?: unknown[]): Promise<unknown[]> {
    return this._driver.execute(sql, params).then((r) => r.rows);
  }

  /** Executes a SQL statement and returns affected-row metadata. */
  run(sql: string, params?: unknown[]): Promise<{ lastID?: number; changes: number }> {
    return this._driver
      .execute(sql, params)
      .then((r) => ({ lastID: r.lastID, changes: r.changes }));
  }

  /** Runs `fn` inside a transaction; commits on success, rolls back on error. */
  async transaction<T>(fn: (trx: Trx) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const conn = await this._driver.connect();
    const trx = this._driver.createTrx(conn, options);
    try {
      return await runInTrxStorage(trx, () => trx.transaction(fn));
    } finally {
      await conn.release();
    }
  }

  /**
   * Begin an explicit transaction and return the Trx handle.
   * You are responsible for calling trx.commit() or trx.rollback().
   *
   * @example
   * const trx = await db.beginTrx();
   * try {
   *   await User.query(trx).insert({ name: "Alice" });
   *   const nested = await trx.beginTrx();
   *   try {
   *     await Post.query(nested).insert({ title: "Hello", authorId: 1 });
   *     await nested.commit();
   *   } catch { await nested.rollback(); }
   *   await trx.commit();
   * } catch { await trx.rollback(); }
   */
  async beginTrx(options?: TransactionOptions): Promise<Trx> {
    const conn = await this._driver.connect();
    const trx = this._driver.createTrx(conn, options);
    await trx._initRoot(() => conn.release());
    return trx;
  }

  /** CREATE TABLE IF NOT EXISTS for all registered entities (ordered by FK deps). */
  async migrate(): Promise<void> {
    const compiler = this._driver.dialect.queryCompiler;
    const entities = getRegisteredEntities();
    const deps = parseFkDependencies(entities);
    const names = entities.map((e) => e.table._table);
    const sorted = topoSort(names, deps);
    const byName = new Map(entities.map((e) => [e.table._table, e]));

    for (const name of sorted) {
      const entity = byName.get(name);
      if (!entity) continue;
      const { _schema: schema } = entity.table;
      await this.run(compiler.compileCreateTableIfNotExists(name, schema));
    }
  }

  /** Validate all registered entities against the database. Throws on mismatch. */
  async validate(): Promise<void> {
    for (const entity of getRegisteredEntities()) {
      const { _table: name, _schema: schema } = entity.table;
      const expectedCols = Object.keys(schema);

      const rows = await this._driver.dialect.migrations.getDbColumns(this._driver, name);

      if (rows.length === 0) {
        throw new Error(`validate: table "${name}" does not exist in the database.`);
      }

      const dbCols = new Map(rows.map((r) => [r.name, r]));

      for (const col of expectedCols) {
        if (!dbCols.has(col)) {
          throw new Error(
            `validate: column "${col}" is defined in Entity("${name}") but does not exist in the table.`,
          );
        }
      }
    }
  }

  /**
   * Diff entity definitions against the database and generate migration files.
   * Returns the generated files (also written to disk).
   */
  async generateMigrations(dir = this._migrationsFolder): Promise<MigrationFile[]> {
    const entities = getRegisteredEntities();
    const files = await generateMigrationFiles(this._driver, entities);
    if (files.length > 0) writeMigrationFiles(dir, files);
    return files;
  }

  /** Apply pending migration scripts from the migrations directory. */
  async runMigrations(dir = this._migrationsFolder) {
    return runMig(this._driver, dir);
  }

  /** Show applied and pending migration status. */
  async migrationStatus(dir = this._migrationsFolder) {
    return migStatus(this._driver, dir);
  }

  /** Return applied migration records without inspecting pending files. */
  async appliedMigrations() {
    return appliedMig(this._driver);
  }

  /** Return pending executable migration files without applying them. */
  async pendingMigrations(dir = this._migrationsFolder) {
    return pendingMig(this._driver, dir);
  }

  /** Preview migration execution without applying any SQL. */
  async dryRunMigrations(dir = this._migrationsFolder) {
    return dryRunMig(this._driver, dir);
  }

  /** Apply a specific migration by name. Throws if already applied or file not found. */
  async upMigration(name: string, dir = this._migrationsFolder) {
    return upMig(this._driver, dir, name);
  }

  /** Roll back a specific migration by name. Throws if not applied or file not found. */
  async downMigration(name: string, dir = this._migrationsFolder) {
    return downMig(this._driver, dir, name);
  }

  /** Closes the underlying database connection pool. */
  async close(): Promise<void> {
    setDefaultDb(null);
    await this._driver.close();
  }
}
