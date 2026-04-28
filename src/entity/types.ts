/**
 * TableDef (serializable table descriptor) and EntityBase.
 */

import type { InferTable, InferInsert } from "./schema-inference.js";
import type { RelationsMap } from "./relations.js";
import type { SingleRowQueryBuilder } from "../orm/single-row-query-builder.js";
import type { Trx } from "../orm/db.js";

/** Internal table descriptor carrying the table name, schema, relation map, and inferred row types. */
export interface TableDef<
  TSchema extends Record<string, string>,
  TRelations extends RelationsMap = Record<string, never>,
> {
  /** The SQL table name. */
  readonly _table: string;
  /** The raw column schema (`{ colName: 'integer NOT NULL', … }`). */
  readonly _schema: TSchema;
  /** The declared relations map. */
  readonly _relations: TRelations;
  /** Inferred full row type (all columns). */
  readonly _selectType: InferTable<TSchema>;
  /** Inferred insert type (optional columns omitted). */
  readonly _insertType: InferInsert<TSchema>;
}

/** Base interface mixed into every entity instance. Provides change-tracking and the per-instance query builder. */
export interface EntityBase {
  /** Whether this instance has not yet been persisted to the database. */
  _isNew: boolean;
  /** Set of column names modified since last save. */
  _dirty: ReadonlySet<string>;
  /** Returns a `SingleRowQueryBuilder` scoped to this entity instance (optionally within a transaction). */
  query(trx?: Trx): SingleRowQueryBuilder<this>;
}
