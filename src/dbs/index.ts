export * from "./types.js";
export { createSqliteDriver, sqliteDialect, sqliteMigrations } from "./sqlite/index.js";
export type { SqliteDriverOptions } from "./sqlite/index.js";
export { createPostgresDriver, postgresDialect, postgresMigrations } from "./postgres/index.js";
export type { PostgresDriverOptions } from "./postgres/index.js";

import type { DialectImpl, DbMigrations } from "./types.js";
import { sqliteDialect } from "./sqlite/dialect.js";
import { sqliteMigrations } from "./sqlite/migrations.js";
import { postgresDialect } from "./postgres/dialect.js";
import { postgresMigrations } from "./postgres/migrations.js";

const dialectMap: Record<string, DialectImpl> = {
  sqlite: sqliteDialect,
  postgres: postgresDialect,
};

const migrationsMap: Record<string, DbMigrations> = {
  sqlite: sqliteMigrations,
  postgres: postgresMigrations,
};

/** Get dialect implementation by name. */
export function getDialect(name: string): DialectImpl {
  const d = dialectMap[name];
  if (!d) throw new Error(`Unknown dialect: ${name}`);
  return d;
}

/** Get DbMigrations implementation by dialect name. */
export function getDbMigrations(dialect: string): DbMigrations {
  const m = migrationsMap[dialect];
  if (!m) throw new Error(`Unknown dialect: ${dialect}`);
  return m;
}
