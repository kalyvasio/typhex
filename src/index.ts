/**
 * Typhex ORM: Entity-based API with arrow-function query predicates.
 */

export { Db, QueryBuilder } from "./orm/index.js";
export type { DbOptions, QueryState } from "./orm/index.js";
export type { Driver } from "./driver/types.js";
export { createSqliteDriver, createDriver } from "./driver/index.js";
export type { SqliteDriverOptions, CreateDriverOptions } from "./driver/index.js";
export { createPostgresDriver, getDialect } from "./dbs/index.js";
export type { PostgresDriverOptions } from "./dbs/index.js";
export type { IrNode, IrOrderBy, IrSelect } from "./ir/types.js";
export { isIrNode, isIrSelect } from "./ir/types.js";
export { parseArrowToIr, parseArrowToIrSelect } from "./parser/index.js";
export type { ParseOptions } from "./parser/index.js";
export type { CompileResult, CompileOptions } from "./dbs/index.js";
export type { TableDefinition, ColumnDef } from "./schema/index.js";
export { Entity, rel } from "./entity/index.js";
export type {
  EntityClass,
  EntityInstance,
  InferTable,
  InferInsert,
  TableDef,
  EntityBase,
  RelationDef,
  RelationsMap,
  RelationResult,
  RelationType,
  RelationOptions,
  JunctionOptions,
} from "./entity/index.js";
export type { DiffAction, Dialect, MigrationFile, MigrationRecord } from "./migration/index.js";
export { diffSchema, generateMigrationFiles, runMigrations, migrationStatus } from "./migration/index.js";
export type { TyphexConfig } from "./config/types.js";
export { loadConfig } from "./config/load-config.js";
export type { LoadConfigOptions } from "./config/load-config.js";
