import type { Driver } from "../driver/types.js";
import type { Dialect } from "../dialect.js";
import type { DiffAction, DbColumnInfo } from "../dbs/types.js";

export type { Dialect, DiffAction, DbColumnInfo };

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrationRecord {
  id: number;
  name: string;
  applied_at: string;
}

export interface MigrationConfig {
  dir: string;
  driver: Driver;
}
