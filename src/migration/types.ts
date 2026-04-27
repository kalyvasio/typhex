import type { Driver } from "../driver/types.js";
import type { Dialect } from "../dialect.js";
import type { DiffAction, DbColumnInfo } from "../dbs/types.js";

export type { Dialect, DiffAction, DbColumnInfo };

/** A generated migration file: name and SQL content. */
export interface MigrationFile {
  /** File name (without `.sql` extension). */
  name: string;
  /** SQL statements to apply this migration. */
  sql: string;
}

/** A row from the `_typhex_migrations` tracking table. */
export interface MigrationRecord {
  /** Auto-incrementing row ID. */
  id: number;
  /** Migration file name (without `.sql` extension). */
  name: string;
  /** ISO timestamp when this migration was applied. */
  applied_at: string;
}

export interface MigrationConfig {
  dir: string;
  driver: Driver;
}
