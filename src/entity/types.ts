/**
 * TableDef (serializable table descriptor) and EntityBase (instance interface).
 */

import type { InferTable, InferInsert } from "./schema-inference.js";
import type { RelationsMap } from "./relations.js";

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

  save(): Promise<this>;
  delete(): Promise<void>;

  beforeSave?(): void | Promise<void>;
  afterSave?(): void | Promise<void>;
  beforeCreate?(): void | Promise<void>;
  afterCreate?(): void | Promise<void>;
  beforeUpdate?(): void | Promise<void>;
  afterUpdate?(): void | Promise<void>;
  afterLoad?(): void | Promise<void>;
  beforeDelete?(): void | Promise<void>;
  afterDelete?(): void | Promise<void>;
}
