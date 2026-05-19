/**
 * SQLite dialect identity and capabilities.
 *
 * SQL generation lives in `SqliteQueryCompiler`.
 */

import type { DialectImpl } from "../types.js";
import { sqliteQueryCompiler } from "./query-compiler.js";

export const sqliteDialect: DialectImpl = {
  name: "sqlite",
  insertCapabilities: {
    supportsReturning: true,
    supportsSequences: false,
  },
  queryCompiler: sqliteQueryCompiler,
};
