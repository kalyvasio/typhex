/**
 * Single-row query builder: save(), delete(), patch() for an entity instance.
 * No _dirty tracking: save() inserts if no pk, else updates all current column values.
 */

import type { Driver } from "../driver/types.js";
import type { QueryState } from "./query-builder.js";
import { QueryBuilder } from "./query-builder.js";
import { whereColumnEq } from "./query-helpers.js";

export interface SingleRowQueryBuilderStateFactory {
  (driver: Driver): QueryState<unknown>;
}

export class SingleRowQueryBuilder<T = unknown> {
  constructor(
    private readonly instance: Record<string, unknown>,
    private readonly getState: SingleRowQueryBuilderStateFactory,
    private readonly resolveDriver: () => Driver,
    private readonly runHook: (instance: unknown, name: string) => Promise<void>,
    private readonly pkColumn: string,
    private readonly columnNames: string[],
  ) {}

  /** Insert if instance has no pk, else update all column values. No _dirty; uses current instance state. */
  async save(): Promise<void> {
    const self = this.instance as T & { _isNew?: boolean };
    await this.runHook(self, "beforeSave");
    const driver = this.resolveDriver();
    const state = this.getState(driver);
    const pkVal = this.instance[this.pkColumn];

    if (pkVal === undefined || pkVal === null) {
      await this.runHook(self, "beforeCreate");
      const row: Record<string, unknown> = {};
      for (const c of this.columnNames) {
        if (this.instance[c] !== undefined) row[c] = this.instance[c];
      }
      const inserted = (await new QueryBuilder({ ...state }).insert(row)) as unknown as Record<string, unknown>;
      for (const c of this.columnNames) {
        if (inserted[c] !== undefined) this.instance[c] = inserted[c];
      }
      if (typeof (self as any)._isNew === "boolean") (self as any)._isNew = false;
      await this.runHook(self, "afterCreate");
    } else {
      await this.runHook(self, "beforeUpdate");
      const set: Record<string, unknown> = {};
      for (const c of this.columnNames) {
        if (c !== this.pkColumn && this.instance[c] !== undefined) set[c] = this.instance[c];
      }
      if (Object.keys(set).length > 0) {
        await new QueryBuilder({
          ...state,
          whereIr: whereColumnEq(this.pkColumn, pkVal),
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
    const pkVal = this.instance[this.pkColumn];
    if (pkVal === undefined || pkVal === null) {
      await this.runHook(self, "afterDelete");
      return;
    }
    const driver = this.resolveDriver();
    const state = this.getState(driver);
    await new QueryBuilder({
      ...state,
      whereIr: whereColumnEq(this.pkColumn, pkVal),
      whereParams: {},
    }).delete();
    await this.runHook(self, "afterDelete");
  }

  /** Update the row by pk with the given set, then assign set onto the instance. */
  async patch(set: Record<string, unknown>): Promise<void> {
    const pkVal = this.instance[this.pkColumn];
    if (pkVal === undefined || pkVal === null) return;
    const driver = this.resolveDriver();
    const state = this.getState(driver);
    await new QueryBuilder({
      ...state,
      whereIr: whereColumnEq(this.pkColumn, pkVal),
      whereParams: {},
    }).update(set);
    for (const k of Object.keys(set)) this.instance[k] = set[k];
  }
}
