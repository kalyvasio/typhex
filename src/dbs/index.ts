export * from "./types.js";
export {
  createSqliteDriver,
  sqliteDialect,
  sqliteMigrations,
  sqliteQueryCompiler,
} from "./sqlite/index.js";
export type { SqliteDriverOptions } from "./sqlite/index.js";
export {
  createPostgresDriver,
  postgresDialect,
  postgresMigrations,
  postgresQueryCompiler,
} from "./postgres/index.js";
export type { PostgresDriverOptions } from "./postgres/index.js";

import type { Dialect, DialectName, QueryCompiler } from "./types.js";
import type { BaseMigrations } from "./base-migrations.js";
import { sqliteDialect } from "./sqlite/dialect.js";
import { sqliteMigrations } from "./sqlite/migrations.js";
import { postgresDialect } from "./postgres/dialect.js";
import { postgresMigrations } from "./postgres/migrations.js";

const dialectMap: Record<DialectName, Dialect> = {
  sqlite: sqliteDialect,
  postgres: postgresDialect,
};

const migrationsMap: Record<DialectName, BaseMigrations> = {
  sqlite: sqliteMigrations,
  postgres: postgresMigrations,
};

/** Get dialect implementation by name. */
export function getDialect(name: DialectName): Dialect {
  const d = dialectMap[name];
  if (!d) throw new Error(`Unknown dialect: ${name}`);
  return d;
}

/** Get query compiler implementation by dialect name. */
export function getQueryCompiler(dialect: Dialect | DialectName): QueryCompiler {
  return typeof dialect === "string" ? getDialect(dialect).queryCompiler : dialect.queryCompiler;
}

/** Get migrations implementation by dialect object or name. */
export function getDbMigrations(dialect: Dialect | DialectName): BaseMigrations {
  const name = typeof dialect === "string" ? dialect : dialect.name;
  const m = migrationsMap[name];
  if (!m) throw new Error(`Unknown dialect: ${name}`);
  return m;
}
