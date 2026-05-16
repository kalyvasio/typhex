/**
 * PostgreSQL dialect identity and capabilities.
 *
 * SQL generation lives in `PostgresQueryCompiler`.
 */

import type { DialectImpl } from "../types.js";

export const postgresDialect: DialectImpl = {
  name: "postgres",
  insertCapabilities: {
    supportsReturning: true,
    supportsSequences: false,
  },
};
