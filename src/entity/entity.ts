/**
 * Entity(table, schema, relations) — the only supported way to define entities.
 * Returns a class whose instances are Row<TSchema, TRels>.
 */

import type { Trx } from "../orm/trx.js";
import type { QueryExecutor } from "../orm/db.js";
import { getColumnNames } from "../schema/types.js";
import type { TableDefinition } from "../schema/types.js";
import { QueryBuilder, QueryState } from "../orm/query-builder.js";
import { SingleRowQueryBuilder } from "../orm/single-row-query-builder.js";
import type {
  InferTable,
  InferInsert,
  Flatten,
  Materialized,
  MaterializeShape,
} from "./schema-inference.js";
import type {
  JunctionOptions,
  RelationDef,
  RelationsMap,
  RelationQueryable,
  RelationQueryBuilder,
  ManyRelation,
} from "./relations.js";
import type { TableDef, EntityBase } from "./types.js";
import { getDefaultDb, registerEntity, enqueuePendingJunction } from "./global-driver.js";
import { getActiveTrx } from "../orm/db.js";

/** Resolved relation value type for a `RelationDef` R: an array for to-many, a single instance for to-one. */
export type RelationLoadedValue<R> =
  R extends RelationDef<infer E, infer TType>
    ? E extends AnyEntityClass
      ? unknown extends E
        ? TType extends "one-to-many" | "many-to-many"
          ? RelationQueryBuilder<any> & EntityBase[]
          : EntityBase
        : TType extends "one-to-many" | "many-to-many"
          ? ManyRelation<EntityInstance<E>>
          : EntityInstance<E>
      : TType extends "one-to-many" | "many-to-many"
        ? RelationQueryBuilder<any> & EntityBase[]
        : EntityBase
    : never;

/** Base row type: materialized columns merged with loaded relation values and `EntityBase`. */
export type Row<TShape extends Record<string, unknown>, TRels extends RelationsMap = {}> = Flatten<
  MaterializeShape<TShape> & { [K in keyof TRels]: RelationLoadedValue<TRels[K]> }
> &
  EntityBase;

/** Structural interface satisfied by every entity class returned by `Entity()`. */
export interface AnyEntityClass {
  /** The table descriptor: name, schema, and relations. */
  table: TableDef<Record<string, string>, RelationsMap>;
  /** Returns a `QueryBuilder` scoped to this entity, optionally within a transaction or `Db` instance. */
  query<C extends AnyEntityClass>(
    this: C,
    executor?: QueryExecutor,
  ): QueryBuilder<C, EntityInstance<C>>;
  /** Runs `fn` inside a transaction on the default (or entity-scoped) database. */
  transaction<T>(fn: (trx: Trx) => Promise<T>): Promise<T>;
}

/** The raw schema record declared on entity E. */
export type EntitySchema<E extends AnyEntityClass> =
  E["table"] extends TableDef<infer S, any> ? S : never;
/** The `RelationsMap` declared on entity E. */
export type EntityRelations<E extends AnyEntityClass> =
  E["table"] extends TableDef<any, infer R> ? R : never;

/** Materialized column types of entity E (e.g. `{ id: number; name: string }`). */
export type EntityFields<E extends AnyEntityClass> = Materialized<EntitySchema<E>>;
/** Resolved type for a `RelationDef` R: the related entity instance, or the raw target type. */
export type RelationTarget<R> =
  R extends RelationDef<infer E, any> ? (E extends AnyEntityClass ? EntityInstance<E> : E) : never;

/** Relation properties of E typed as lazy query builders (`RelationQueryable`). */
export type EntityRelationProps<E extends AnyEntityClass> = {
  [K in keyof EntityRelations<E>]: RelationQueryable<EntityRelations<E>[K]>;
};

/** Relation properties of E typed as loaded values (arrays or single instances). */
export type EntityRelationPropsLoaded<E extends AnyEntityClass> = {
  [K in keyof EntityRelations<E>]: RelationLoadedValue<EntityRelations<E>[K]>;
};

/** Table-derived instance type (used when E is not a class or as fallback). */
type EntityInstanceFromTable<E extends AnyEntityClass> = Flatten<
  EntityFields<E> & EntityRelationPropsLoaded<E>
> &
  EntityBase;

/** Table-derived select row type. */
type SelectRowFromTable<E extends AnyEntityClass> = Flatten<
  EntityFields<E> & EntityRelationProps<E>
> &
  EntityBase;

/** Loaded entity instance. Uses InstanceType<E> when E is a class so subclass declare (OneToMany etc.) flows through. */
export type EntityInstance<E extends AnyEntityClass> = E extends new (...args: any[]) => infer R
  ? R extends EntityBase
    ? R
    : EntityInstanceFromTable<E>
  : EntityInstanceFromTable<E>;

/** Row type in select(u => ...) callback. Uses InstanceType<E> when E is a class so subclass declare flows through. */
export type SelectRow<E extends AnyEntityClass> = E extends new (...args: any[]) => infer R
  ? R extends EntityBase
    ? R
    : SelectRowFromTable<E>
  : SelectRowFromTable<E>;

/** Alias for `EntityInstance<E>`; resolves to `never` when E is not an entity class. */
export type EntityRow<E> = E extends AnyEntityClass ? EntityInstance<E> : never;

/** Extracts the entity class from an entity instance type. */
export type EntityClassOf<T> =
  T extends EntityInstance<infer E> ? E : T extends AnyEntityClass ? T : never;

function hasPrimaryKey(def: string): boolean {
  const stripped = def.replaceAll(/'[^']*'/g, "").replaceAll(/--[^\n]*/g, "");
  return /\bprimary\s+key\b/i.test(stripped);
}

function getPkColumns(schema: Record<string, string>): string[] {
  const names = Object.keys(schema);
  const pks = names.filter((c) => hasPrimaryKey(schema[c]));
  return pks.length > 0 ? pks : [names[0]];
}

/** Public helper for relation loading: primary key column names from a schema map. */
export function getPkColumnsFromSchema(schema: Record<string, string>): string[] {
  return getPkColumns(schema);
}

function createTableDef<
  TTable extends string,
  TSchema extends Record<string, string>,
  TRels extends RelationsMap,
>(table: TTable, schema: TSchema, relations: TRels): TableDef<TSchema, TRels> {
  return {
    _table: table,
    _schema: schema,
    _relations: relations,
    _selectType: undefined as unknown as InferTable<TSchema>,
    _insertType: undefined as unknown as InferInsert<TSchema>,
  };
}

/** Typed entity class returned by `Entity()`. Extends `AnyEntityClass` with schema-specific types. */
export interface EntityClass<
  _TTable extends string,
  TSchema extends Record<string, string>,
  TRels extends RelationsMap = {},
> extends AnyEntityClass {
  /** Construct a new (unsaved) entity instance with optional partial data. */
  new (data?: Partial<InferTable<TSchema>>): Row<Materialized<TSchema>, TRels>;
  /** Typed table descriptor for this entity. */
  table: TableDef<TSchema, TRels>;
}

/**
 * Define an entity. Schema keys and SQL-like type strings are inferred so that
 * instances and create() get correct types (e.g. id: number, name: string).
 */
export function Entity<
  TTable extends string,
  const TSchema extends Record<string, string>,
  const TRels extends RelationsMap = {},
>(tableName: TTable, schema: TSchema, relations?: TRels): EntityClass<TTable, TSchema, TRels> {
  const rels = (relations ?? {}) as TRels;
  const tableDef = createTableDef(tableName, schema, rels);
  const cols = getColumnNames(schema as TableDefinition);
  const pkCols = getPkColumns(schema);

  function resolveDb() {
    const resolved = getDefaultDb();
    if (!resolved)
      throw new Error(`Entity "${tableName}": no Db. Use new Db(driver) to instantiate typhex.`);
    return resolved;
  }

  function resolveRelationTarget(
    rel: RelationDef,
  ): { table: string; pk: string[]; schema: Record<string, string> } | null {
    try {
      const target = rel._target();
      const entityClass =
        target && typeof target === "function"
          ? (target as { table?: TableDef<Record<string, string>, RelationsMap> })
          : (target as { _selectType?: { table?: TableDef<Record<string, string>, RelationsMap> } })
              ?._selectType;
      const tbl = entityClass?.table;
      if (tbl) {
        const schema = tbl._schema;
        return { table: tbl._table, pk: getPkColumns(schema), schema };
      }
      return null;
    } catch (e) {
      if (e instanceof TypeError || e instanceof ReferenceError) return null;
      throw e;
    }
  }

  function baseState(executor?: QueryExecutor): QueryState<unknown> {
    return {
      tableName,
      columnNames: cols,
      qe: executor ?? resolveDb(),
      pkColumns: pkCols,
      whereIr: null,
      whereParams: {} as Record<string, unknown>,
      subqueryParams: {} as Record<string, unknown>,
      orderBy: [] as any[],
      limitNum: null,
      offsetNum: null,
      selectIr: null,
      relations: rels as RelationsMap,
      resolveRelationTarget,
    };
  }

  function runHook(self: any, name: string): Promise<void> {
    return typeof self[name] === "function" ? Promise.resolve(self[name]()) : Promise.resolve();
  }

  class EntityClassImpl implements EntityBase {
    declare _isNew: boolean;
    declare _dirty: Set<string>;

    static table = tableDef;

    static async transaction<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
      const db = resolveDb();
      return db.transaction(fn);
    }

    static _registerJunctions(): void {
      for (const rd of Object.values(rels)) {
        if (rd._relType !== "many-to-many") continue;
        const opts = rd._options as JunctionOptions;
        enqueuePendingJunction({
          sourceTable: tableName,
          sourceSchema: schema,
          sourcePkCols: pkCols,
          options: opts,
          resolveTarget: () => resolveRelationTarget(rd),
          materialize: (junctionSchema) => {
            Entity(opts.junction, junctionSchema);
          },
        });
      }
    }

    private static _resolveRelations(Ctor: any): RelationsMap {
      const classRels = Ctor.relations as RelationsMap | undefined;
      return classRels && Object.keys(classRels).length > 0 ? classRels : (rels as RelationsMap);
    }

    static query(this: new (data?: any) => any, executor?: QueryExecutor) {
      const Ctor = this;
      const effectiveRels = EntityClassImpl._resolveRelations(Ctor);
      return new QueryBuilder({
        ...baseState(executor),
        entity: Ctor as unknown as AnyEntityClass,
        relations: effectiveRels,
        async hydrate(row: Record<string, unknown>) {
          const inst = new Ctor(row);
          inst._isNew = false;
          inst._dirty = new Set();
          await runHook(inst, "afterLoad");
          return inst;
        },
      }) as unknown as QueryBuilder<any, EntityRow<typeof Ctor>>;
    }

    constructor(data?: Partial<InferTable<TSchema>>) {
      const row = (data ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(row)) {
        if (row[key] !== undefined) (this as Record<string, unknown>)[key] = row[key];
      }
      this._isNew = !pkCols.every((c) => (this as Record<string, unknown>)[c] !== undefined);
      this._dirty = new Set(Object.keys(row).filter((k) => cols.includes(k)));
    }

    query(executor?: QueryExecutor): SingleRowQueryBuilder<this> {
      return new SingleRowQueryBuilder<this>(
        this as unknown as Record<string, unknown>,
        baseState(executor ?? getActiveTrx()),
        runHook,
        pkCols,
        cols,
      );
    }
  }

  const result = EntityClassImpl as unknown as EntityClass<TTable, TSchema, TRels>;
  registerEntity(result);
  return result;
}
