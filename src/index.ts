/**
 * Typhex ORM: Entity-based API with arrow-function query predicates.
 */

// Core runtime
export { Db, Trx, QueryBuilder, SingleRowQueryBuilder, InsertBuilder } from "./orm/index.js";
export { count, sum, avg, min, max, distinct } from "./orm/aggregates.js";
export {
  Entity,
  rel,
  getPkColumnsFromSchema,
  oneToOne,
  manyToOne,
  oneToMany,
  manyToMany,
} from "./entity/index.js";
export { createSqliteDriver, createDriver } from "./driver/index.js";
export { createPostgresDriver } from "./dbs/index.js";
export {
  appliedMigrations,
  diffSchema,
  dryRunMigrations,
  generateMigrationFiles,
  migrationStatus,
  pendingMigrations,
  runMigrations,
  upMigration,
  downMigration,
} from "./migration/index.js";
export { loadConfig } from "./config/load-config.js";

// Builder/executor types
export type { DbOptions, QueryExecutor, OrderDirection } from "./orm/index.js";

// Driver types
export type { Driver, Connection, ExecuteResult, TransactionOptions } from "./driver/types.js";
export type { SqliteDriverOptions, CreateDriverOptions } from "./driver/index.js";
export type { PostgresDriverOptions } from "./dbs/index.js";
export type { ColumnDef } from "./dbs/types.js";
export type { WithClause, RenderedWithClause } from "./dbs/types.js";
export type { FromSource } from "./orm/query-state.js";

// Entity machinery
export type {
  AnyEntityClass,
  EntityBase,
  EntityClass,
  EntityClassOf,
  EntityInstance,
  EntityRow,
  EntitySchema,
  EntityRelations,
  EntityFields,
  SelectRow,
  TableDef,
  RelationLoadedValue,
  RelationTarget,
  EntityRelationProps,
  EntityRelationPropsLoaded,
} from "./entity/index.js";

// Schema/type helpers
export type {
  InferTable,
  InferInsert,
  Flatten,
  InferColumnType,
  Materialized,
  MaterializeShape,
  Mutable,
  IsNotNull,
  IsGenerated,
  HasDefault,
  SQLToTS,
  SQLTypeMap,
  ExtractSQLBase,
  StripParens,
  OptionalOnInsert,
} from "./entity/index.js";

// Additional entity machinery
export type { Row } from "./entity/index.js";

// Relation types
export type {
  OneToMany,
  ManyToOne,
  OneToOne,
  ManyToMany,
  RelationDef,
  RelationsMap,
  RelationOptions,
  JunctionOptions,
  RelationKind,
  RelationType,
  RelationQueryBuilder,
  RelationQueryable,
  RelatedEntityInstance,
  ManyRelation,
  SingleRelation,
  ToEntityInstance,
  OneToOneDef,
  ManyToOneDef,
  OneToManyDef,
  ManyToManyDef,
} from "./entity/index.js";
export type { RegisteredEntity } from "./entity/index.js";

// Migration
export type {
  DiffAction,
  Dialect,
  DialectName,
  MigrationFile,
  MigrationRecord,
  MigrationResult,
  PendingMigration,
  MigrationDryRun,
  MigrationDb,
} from "./migration/index.js";

// Config
export type { TyphexConfig } from "./config/types.js";
export type { LoadConfigOptions } from "./config/load-config.js";
