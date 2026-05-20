/**
 * PostgreSQL dialect identity and capabilities.
 *
 * SQL generation lives in `PostgresQueryCompiler`.
 */

import type { Dialect } from "../types.js";
import { postgresMigrations } from "./migrations.js";
import { postgresQueryCompiler } from "./query-compiler.js";

export const postgresDialect: Dialect = {
  name: "postgres",
  insertCapabilities: {
    supportsReturning: true,
    supportsSequences: false,
  },
  queryCompiler: postgresQueryCompiler,
  migrations: postgresMigrations,
};
