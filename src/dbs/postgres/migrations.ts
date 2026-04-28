/**
 * PostgreSQL migrations: diff and DDL generation.
 */

import type { Driver, DbMigrations, DiffAction, DbColumnInfo } from "../types.js";
import { getColumnDef } from "../types.js";
import { postgresDialect } from "./dialect.js";
import type { RegisteredEntity } from "../../entity/global-driver.js";
import { diffSchemaBase, generateCommonSql, generateCommonDownSql } from "../shared-migrations.js";

export const postgresMigrations: DbMigrations = {
  dialect: "postgres",

  async getDbTables(driver: Driver): Promise<string[]> {
    const rows = await driver
      .execute(
        `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != '_typhex_migrations'
    `,
      )
      .then((r) => r.rows);
    return (rows as Array<{ table_name: string }>).map((r) => r.table_name);
  },

  async getDbColumns(driver: Driver, table: string): Promise<DbColumnInfo[]> {
    const rows = await driver
      .execute(
        `
      SELECT column_name as name, data_type as type,
             CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END as notnull,
             column_default as dflt_value,
             CASE WHEN column_name IN (
               SELECT kcu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
               WHERE tc.table_schema = 'public'
                 AND tc.table_name = $1
                 AND tc.constraint_type = 'PRIMARY KEY'
             ) THEN 1 ELSE 0 END as pk
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
        [table],
      )
      .then((r) => r.rows);
    return rows as DbColumnInfo[];
  },

  async diffSchema(driver: Driver, entities: readonly RegisteredEntity[]): Promise<DiffAction[]> {
    return diffSchemaBase(
      "postgres",
      () => this.getDbTables(driver),
      (table) => this.getDbColumns(driver, table),
      entities,
    );
  },

  generateSql(action: DiffAction): string {
    const shared = generateCommonSql(action, postgresDialect);
    if (shared !== null) return shared;
    // alter_column
    const a = action as Extract<DiffAction, { kind: "alter_column" }>;
    const esc = postgresDialect.escapeIdentifier.bind(postgresDialect);
    return `ALTER TABLE ${esc(a.table)} ALTER COLUMN ${esc(a.column)} TYPE ${getColumnDef(a.newDef, "postgres")};`;
  },

  getTrackingTableDdl(): string {
    const esc = postgresDialect.escapeIdentifier.bind(postgresDialect);
    return `CREATE TABLE IF NOT EXISTS ${esc("_typhex_migrations")} (
  ${esc("id")} SERIAL PRIMARY KEY,
  ${esc("name")} TEXT NOT NULL UNIQUE,
  ${esc("applied_at")} TIMESTAMP NOT NULL DEFAULT NOW()
)`;
  },

  getRecordMigrationSql(): string {
    const esc = postgresDialect.escapeIdentifier.bind(postgresDialect);
    return `INSERT INTO ${esc("_typhex_migrations")} (${esc("name")}) VALUES ($1)`;
  },

  getDeleteMigrationSql(): string {
    const esc = postgresDialect.escapeIdentifier.bind(postgresDialect);
    return `DELETE FROM ${esc("_typhex_migrations")} WHERE ${esc("name")} = $1`;
  },

  generateDownSql(action: DiffAction): string {
    const shared = generateCommonDownSql(action, postgresDialect);
    if (shared !== null) return shared;
    // alter_column: reverse by restoring old type
    const a = action as Extract<DiffAction, { kind: "alter_column" }>;
    const esc = postgresDialect.escapeIdentifier.bind(postgresDialect);
    return `ALTER TABLE ${esc(a.table)} ALTER COLUMN ${esc(a.column)} TYPE ${a.oldDef};`;
  },
};
