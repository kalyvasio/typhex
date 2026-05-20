/**
 * SQLite dialect identity and capabilities.
 *
 * SQL generation lives in `SqliteQueryCompiler`.
 */

import type { Dialect } from "../types.js";
import { sqliteMigrations } from "./migrations.js";
import { sqliteQueryCompiler } from "./query-compiler.js";

export const sqliteDialect: Dialect = {
  name: "sqlite",
  insertCapabilities: {
    supportsReturning: true,
    supportsSequences: false,
  },
  queryCompiler: sqliteQueryCompiler,
  migrations: sqliteMigrations,
};
