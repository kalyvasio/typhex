import type { Driver } from "../driver/types.js";
import type { DialectName, DiffAction, DbColumnInfo } from "../dbs/types.js";

export type { DialectName, DiffAction, DbColumnInfo };

/** Minimal DB handle passed into up(db) and down(db) migration functions. */
export interface MigrationDb {
  run(sql: string, params?: unknown[]): Promise<void>;
}

/** A generated migration file: name, SQL content, and rendered module. */
export interface MigrationFile {
  /** File name (without extension). */
  name: string;
  /** SQL statements to apply this migration. */
  upSql: string;
  /** SQL statements to roll back this migration. */
  downSql: string;
  /** Rendered JavaScript migration module content. */
  content: string;
}

/** A row from the `_typhex_migrations` tracking table. */
export interface MigrationRecord {
  /** Auto-incrementing row ID. */
  id: number;
  /** Migration file name (without extension). */
  name: string;
  /** ISO timestamp when this migration was applied. */
  applied_at: string;
}

export interface PendingMigration {
  name: string;
  file: string;
  upSql: string;
  downSql: string;
  statements: string[];
  downStatements: string[];
}

export interface MigrationDryRun {
  applied: MigrationRecord[];
  pending: PendingMigration[];
  skipped: string[];
}

export interface MigrationConfig {
  dir: string;
  driver: Driver;
}
