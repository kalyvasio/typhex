/**
 * PostgreSQL dialect identity and capabilities.
 *
 * SQL generation lives in `PostgresQueryCompiler`.
 */

import type { DialectImpl } from "../types.js";
import { postgresQueryCompiler } from "./query-compiler.js";

export const postgresDialect: DialectImpl = {
  name: "postgres",
  insertCapabilities: {
    supportsReturning: true,
    supportsSequences: false,
  },
  queryCompiler: postgresQueryCompiler,
};
