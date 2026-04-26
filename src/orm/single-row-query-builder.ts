/**
 * Single-row query builder: save(), delete(), patch() for an entity instance.
 * No _dirty tracking: save() inserts if no pk, else updates all current column values.
 */

import type { QueryState } from "./query-builder.js";
import { QueryBuilder } from "./query-builder.js";
import { buildFindByIdIr } from "./query-helpers.js";

export class SingleRowQueryBuilder<T = unknown> {
  constructor(
    private readonly instance: Record<string, unknown>,
    private readonly state: QueryState<unknown>,
    private readonly runHook: (instance: unknown, name: string) => Promise<void>,
    private readonly pkColumns: string[],
    private readonly columnNames: string[],
  ) {}

  /** Insert if instance has no complete pk, else update all column values. No _dirty; uses current instance state. */
  async save(): Promise<void> {
    const self = this.instance as T & { _isNew?: boolean };
    await this.runHook(self, "beforeSave");
    const hasAllPk = this.pkColumns.every((c) => this.instance[c] !== undefined);

    if (!hasAllPk) {
      await this.runHook(self, "beforeCreate");
      const row: Record<string, unknown> = {};
      for (const c of this.columnNames) {
        if (this.instance[c] !== undefined) row[c] = this.instance[c];
      }
      const inserted = (await new QueryBuilder({ ...this.state }).insert(row)) as unknown as Record<
        string,
        unknown
      >;
      for (const c of this.columnNames) {
        if (inserted[c] !== undefined) this.instance[c] = inserted[c];
      }
      if (typeof (self as any)._isNew === "boolean") (self as any)._isNew = false;
      await this.runHook(self, "afterCreate");
    } else {
      await this.runHook(self, "beforeUpdate");
      const set: Record<string, unknown> = {};
      for (const c of this.columnNames) {
        if (!this.pkColumns.includes(c) && this.instance[c] !== undefined)
          set[c] = this.instance[c];
      }
      if (Object.keys(set).length > 0) {
        await new QueryBuilder({
          ...this.state,
          whereIr: buildFindByIdIr(this.pkColumns, this.instance),
          whereParams: {},
        }).update(set);
      }
      await this.runHook(self, "afterUpdate");
    }
    await this.runHook(self, "afterSave");
  }

  /** Delete the row by pk. */
  async delete(): Promise<void> {
    const self = this.instance;
    await this.runHook(self, "beforeDelete");
    const hasAllPk = this.pkColumns.every((c) => this.instance[c] !== undefined);
    if (!hasAllPk) {
      await this.runHook(self, "afterDelete");
      return;
    }
    await new QueryBuilder({
      ...this.state,
      whereIr: buildFindByIdIr(this.pkColumns, this.instance),
      whereParams: {},
    }).delete();
    await this.runHook(self, "afterDelete");
  }

  /** Update the row by pk with the given set, then assign set onto the instance. */
  async patch(set: Record<string, unknown>): Promise<void> {
    const hasAllPk = this.pkColumns.every((c) => this.instance[c] !== undefined);
    if (!hasAllPk) return;
    await new QueryBuilder({
      ...this.state,
      whereIr: buildFindByIdIr(this.pkColumns, this.instance),
      whereParams: {},
    }).update(set);
    for (const k of Object.keys(set)) this.instance[k] = set[k];
  }
}
