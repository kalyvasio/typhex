/**
 * Typhex configuration schema.
 * Used by Db, CLI, and config file.
 */

import type { Dialect } from "../dialect.js";

/** Typhex configuration: dialect, connection details, and paths. */
export interface TyphexConfig {
  /** Database dialect */
  dialect: Dialect;
  /** SQLite: path to database file (or ":memory:") */
  database?: string;
  /** PostgreSQL: connection URL (future) */
  url?: string;
  /** Migrations directory */
  migrationsFolder?: string;
  /** Path to entities module (for migrate:generate) */
  entities?: string;
}

export const DEFAULT_CONFIG: Partial<TyphexConfig> = {
  dialect: "sqlite",
  migrationsFolder: "./migrations",
  entities: "./src/entities.ts",
};
