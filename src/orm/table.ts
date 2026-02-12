/**
 * Table: schema + query builder entry point + CRUD.
 */

import type { Driver } from "../driver/types.js";
import type { TableDefinition } from "../schema/types.js";
import { getColumnNames } from "../schema/types.js";
import type { IrNode } from "../ir/types.js";
import { QueryBuilder } from "./query-builder.js";

export class Table<T = Record<string, unknown>> {
  readonly columnNames: string[];

  constructor(
    public readonly tableName: string,
    public readonly definition: TableDefinition,
    private driver: Driver
  ) {
    this.columnNames = getColumnNames(definition);
  }

  where(
    predicate: IrNode | ((entity: T) => boolean),
    params?: Record<string, unknown>
  ): QueryBuilder<T> {
    return this.all().where(predicate, params);
  }

  all(): QueryBuilder<T> {
    return new QueryBuilder({
      table: this,
      driver: this.driver,
      whereIr: null,
      whereParams: {},
      orderBy: [],
      limitNum: null,
      offsetNum: null,
      selectIr: null,
    });
  }

  findById(id: string | number): T | undefined {
    const pk = this.columnNames[0];
    const whereIr: IrNode = {
      kind: "binary",
      op: "===",
      left: { kind: "member", param: "u", path: [pk] },
      right: { kind: "const", value: id },
    };
    return this.all().where(whereIr).first();
  }

  insert(row: Partial<T> & Record<string, unknown>): number {
    const cols = this.columnNames.filter((c) => row[c] !== undefined);
    const placeholders = cols.map(() => "?").join(", ");
    const quoted = cols.map((c) => `"${c}"`).join(", ");
    const sql = `INSERT INTO "${this.tableName}" (${quoted}) VALUES (${placeholders})`;
    const params = cols.map((c) => row[c]);
    const result = this.driver.run(sql, params);
    return result.lastID ?? 0;
  }

  update(
    predicate: IrNode | ((entity: T) => boolean),
    set: Partial<T> & Record<string, unknown>,
    params?: Record<string, unknown>
  ): number {
    return this.all().where(predicate, params).update(set as Record<string, unknown>);
  }

  delete(
    predicate: IrNode | ((entity: T) => boolean),
    params?: Record<string, unknown>
  ): number {
    return this.all().where(predicate, params).delete();
  }
}
