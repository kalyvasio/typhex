import type { Driver } from "../driver/types.js";
import type { Dialect } from "../dialect.js";

export type { Dialect };

export interface DbColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export type DiffAction =
  | { kind: "add_table"; table: string; schema: Record<string, string> }
  | { kind: "drop_table"; table: string }
  | { kind: "add_column"; table: string; column: string; definition: string }
  | { kind: "drop_column"; table: string; column: string }
  | { kind: "alter_column"; table: string; column: string; oldDef: string; newDef: string };

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
