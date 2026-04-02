/**
 * TableDef (serializable table descriptor) and EntityBase.
 */

import type { InferTable, InferInsert } from "./schema-inference.js";
import type { RelationsMap } from "./relations.js";
import type { SingleRowQueryBuilder } from "../orm/single-row-query-builder.js";
import {Db, Trx} from "../orm/db.js";

export interface TableDef<
  TSchema extends Record<string, string>,
  TRelations extends RelationsMap = Record<string, never>,
> {
  readonly _table: string;
  readonly _schema: TSchema;
  readonly _relations: TRelations;
  readonly _selectType: InferTable<TSchema>;
  readonly _insertType: InferInsert<TSchema>;
}

export interface EntityBase {
  _isNew: boolean;
  _dirty: ReadonlySet<string>;

  query(trx?: Trx): SingleRowQueryBuilder<this>;
}
