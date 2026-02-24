/**
 * Entity(table, schema, relations) — the only supported way to define entities.
 * Returns a class whose instances are InferTable<TSchema> & EntityBase.
 */

import type { Driver } from "../driver/types.js";
import { getColumnNames } from "../schema/types.js";
import type { TableDefinition } from "../schema/types.js";
import { QueryBuilder } from "../orm/query-builder.js";
import type { InferTable, InferInsert } from "./schema-inference.js";
import type { RelationsMap } from "./relations.js";
import type { TableDef, EntityBase } from "./types.js";
import { getDefaultDriver, registerEntity } from "./global-driver.js";

function hasPrimaryKey(def: string): boolean {
  const stripped = def
    .replace(/'[^']*'/g, "")
    .replace(/--[^\n]*/g, "");
  return /\bprimary\s+key\b/i.test(stripped);
}

function getPkColumn(schema: Record<string, string>): string {
  const names = Object.keys(schema);
  return names.find((c) => hasPrimaryKey(schema[c])) ?? names[0];
}

function createTableDef<TTable extends string, TSchema extends Record<string, string>, TRels extends RelationsMap>(
  table: TTable,
  schema: TSchema,
  relations: TRels
): TableDef<TSchema, TRels> {
  return {
    _table: table,
    _schema: schema,
    _relations: relations,
    _selectType: undefined as unknown as InferTable<TSchema>,
    _insertType: undefined as unknown as InferInsert<TSchema>,
  };
}

export type EntityClass<
  TTable extends string,
  TSchema extends Record<string, string>,
  TRels extends RelationsMap,
  TInstance = InferTable<TSchema> & EntityBase,
> = (new (data?: Partial<InferTable<TSchema>>) => TInstance) & {
  table: TableDef<TSchema, TRels>;
  _driver: Driver | null;
  useDriver(driver: Driver): void;
  query<C extends new (...args: any[]) => any>(this: C, driver?: Driver): QueryBuilder<InstanceType<C>>;
  findById<C extends new (...args: any[]) => any>(this: C, id: number, driver?: Driver): Promise<InstanceType<C> | null>;
  create<C extends new (...args: any[]) => any>(this: C, data: InferInsert<TSchema>, driver?: Driver): Promise<InstanceType<C>>;
};

export type EntityInstance<E> =
  E extends EntityClass<any, infer S, any> ? InferTable<S> & EntityBase : never;

/**
 * Define an entity. Schema keys and SQL-like type strings are inferred so that
 * instances and create() get correct types (e.g. id: number, name: string).
 */
export function Entity<
  TTable extends string,
  const TSchema extends Record<string, string>,
  TRels extends RelationsMap = Record<string, never>,
>(
  tableName: TTable,
  schema: TSchema,
  relations?: TRels
): EntityClass<TTable, TSchema, TRels> {
  const rels = (relations ?? {}) as TRels;
  const tableDef = createTableDef(tableName, schema, rels);
  const cols = getColumnNames(schema as TableDefinition);
  const pk = getPkColumn(schema);

  function resolveDriver(override?: Driver): Driver {
    const d = override ?? (EntityClassImpl as any)._driver ?? getDefaultDriver();
    if (!d) throw new Error(`Entity "${tableName}": no driver. Use new Db(driver) or call ${tableName}.useDriver(driver).`);
    return d;
  }

  function baseState(driver: Driver) {
    return {
      tableName,
      columnNames: cols,
      driver,
      pkColumn: pk,
      whereIr: null as null,
      whereParams: {} as Record<string, unknown>,
      orderBy: [] as any[],
      limitNum: null as null,
      offsetNum: null as null,
      selectIr: null as null,
    };
  }

  function runHook(self: any, name: string): Promise<void> {
    return typeof self[name] === "function" ? Promise.resolve(self[name]()) : Promise.resolve();
  }

  class EntityClassImpl implements EntityBase {
    declare _isNew: boolean;
    declare _dirty: Set<string>;

    static table = tableDef;
    static _driver: Driver | null = null;

    static useDriver(driver: Driver) {
      EntityClassImpl._driver = driver;
    }

    static query(this: new (data?: any) => any, driverOverride?: Driver) {
      const d = resolveDriver(driverOverride);
      const Ctor = this;
      return new QueryBuilder({
        ...baseState(d),
        async hydrate(row: Record<string, unknown>) {
          const inst = new Ctor(row);
          inst._isNew = false;
          inst._dirty = new Set();
          await runHook(inst, "afterLoad");
          return inst;
        },
      });
    }

    static async findById(this: new (data?: any) => any, id: number, driverOverride?: Driver): Promise<any> {
      return (this as any).query(driverOverride).findById(id);
    }

    static async create(this: new (data?: any) => any, data: any, driverOverride?: Driver): Promise<any> {
      return (this as any).query(driverOverride).create(data as Record<string, unknown>);
    }

    constructor(data?: Partial<InferTable<TSchema>>) {
      const row = (data ?? {}) as Record<string, unknown>;
      for (const c of cols) {
        if (row[c] !== undefined) (this as Record<string, unknown>)[c] = row[c];
      }
      this._isNew = (this as any)[pk] === undefined;
      this._dirty = new Set(Object.keys(row));
    }

    async save(): Promise<this> {
      const self = this as any;
      await runHook(self, "beforeSave");
      if (self._isNew) {
        await runHook(self, "beforeCreate");
        const qb = new QueryBuilder(baseState(resolveDriver()));
        const row: Record<string, unknown> = {};
        for (const c of cols) if (self[c] !== undefined) row[c] = self[c];
        self[pk] = await qb.insert(row);
        self._isNew = false;
        self._dirty = new Set();
        await runHook(self, "afterCreate");
      } else if (self._dirty?.size > 0) {
        await runHook(self, "beforeUpdate");
        const qb = new QueryBuilder(baseState(resolveDriver()));
        const set: Record<string, unknown> = {};
        for (const c of self._dirty) if (cols.includes(c)) set[c] = self[c];
        await qb.updateByPk(self[pk], set);
        self._dirty = new Set();
        await runHook(self, "afterUpdate");
      }
      await runHook(self, "afterSave");
      return this;
    }

    async delete(): Promise<void> {
      const self = this as any;
      await runHook(self, "beforeDelete");
      await new QueryBuilder(baseState(resolveDriver())).deleteByPk(self[pk]);
      await runHook(self, "afterDelete");
    }
  }

  const result = EntityClassImpl as unknown as EntityClass<TTable, TSchema, TRels>;
  registerEntity(result);
  return result;
}
