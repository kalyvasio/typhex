/**
 * Typhex ORM: arrow-function query predicates + full ORM features.
 */

export { Db, Table, QueryBuilder } from "./orm/index.js";
export type { QueryState } from "./orm/index.js";
export type { Driver } from "./driver/types.js";
export { createSqliteDriver } from "./driver/index.js";
export type { SqliteDriverOptions } from "./driver/index.js";
export type { IrNode, IrOrderBy, IrSelect } from "./ir/types.js";
export { isIrNode, isIrSelect } from "./ir/types.js";
export { parseArrowToIr } from "./parser/index.js";
export type { ParseOptions } from "./parser/index.js";
export { compileWhere, bindParams, expandInParams } from "./compiler/index.js";
export type { CompileResult, CompileOptions } from "./compiler/index.js";
export type { TableDefinition, ColumnDef } from "./schema/index.js";
