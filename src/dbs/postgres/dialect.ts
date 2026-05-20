/**
 * PostgreSQL dialect identity and capabilities.
 *
 * SQL generation lives in `PostgresQueryCompiler`.
 */

import type { Dialect } from "../types.js";
import { postgresMigrator } from "./migrator.js";
import { postgresQueryCompiler } from "./query-compiler.js";

export const postgresDialect: Dialect = {
  name: "postgres",
  insertCapabilities: {
    supportsReturning: true,
    supportsSequences: false,
  },
  queryCompiler: postgresQueryCompiler,
  migrator: postgresMigrator,
};
