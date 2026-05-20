export * from "./types.js";
export {
  createSqliteDriver,
  sqliteDialect,
  sqliteMigrator,
  sqliteQueryCompiler,
} from "./sqlite/index.js";
export type { SqliteDriverOptions } from "./sqlite/index.js";
export {
  createPostgresDriver,
  postgresDialect,
  postgresMigrator,
  postgresQueryCompiler,
} from "./postgres/index.js";
export type { PostgresDriverOptions } from "./postgres/index.js";

import type { Dialect, DialectName } from "./types.js";
import { sqliteDialect } from "./sqlite/dialect.js";
import { postgresDialect } from "./postgres/dialect.js";

const dialectMap: Record<DialectName, Dialect> = {
  sqlite: sqliteDialect,
  postgres: postgresDialect,
};

/** Get dialect implementation by name. */
export function getDialect(name: DialectName): Dialect {
  const d = dialectMap[name];
  if (!d) throw new Error(`Unknown dialect: ${name}`);
  return d;
}
