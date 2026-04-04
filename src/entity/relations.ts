/**
 * Relation definitions for Entity(table, schema, relations).
 * Target is a thunk (() => EntityClass) that defers evaluation for circular imports.
 */
import type { AnyEntityClass, EntityClassOf, EntityInstance, SelectRow } from "./entity.js";
import type { EntityBase } from "./types.js";

/** Union of the four relation kinds. */
export type RelationType = "one-to-one" | "many-to-one" | "one-to-many" | "many-to-many";

/** FK options for to-one and to-many relations. */
export interface RelationOptions {
  /** Column(s) on the owning table that hold the foreign key. */
  foreignKey: string | string[];
  /** Column(s) on the referenced table (defaults to primary key). */
  references?: string | string[];
}

/** Options for a many-to-many relation through a junction table. */
export interface JunctionOptions {
  /** Name of the junction (join) table. */
  junction: string;
  /** Column(s) in the junction table that reference the owning entity. */
  foreignKey: string | string[];
  /** Column(s) in the junction table that reference the related entity. */
  referenceKey: string | string[];
}

/** Internal descriptor created by the relation factory functions (`oneToOne`, `manyToOne`, etc.). */
export interface RelationDef<_E = unknown, TType extends RelationType = RelationType> {
  /** The relation kind string. */
  readonly _relType: TType;
  /** Thunk returning the related entity class (deferred to handle circular imports). */
  readonly _target: () => unknown;
  /** FK or junction options provided when defining the relation. */
  readonly _options: RelationOptions | JunctionOptions;
}

/** Definition type for one-to-one relations (result of `oneToOne()`). */
export type OneToOneDef<E> = RelationDef<E, "one-to-one">;
/** Definition type for many-to-one relations (result of `manyToOne()`). */
export type ManyToOneDef<E> = RelationDef<E, "many-to-one">;
/** Definition type for one-to-many relations (result of `oneToMany()`). */
export type OneToManyDef<E> = RelationDef<E, "one-to-many">;
/** Definition type for many-to-many relations (result of `manyToMany()`). */
export type ManyToManyDef<E> = RelationDef<E, "many-to-many">;

/** Record mapping relation property names to their `RelationDef` descriptors. */
export type RelationsMap = Record<string, RelationDef<any, RelationType>>;

/** Fluent builder returned by a loaded relation's `.query()` call. */
export interface RelationQueryBuilder<T> {
  /** Returns a fresh query builder for this relation (resets any applied filters). */
  query(): RelationQueryBuilder<T>;
  /** Filters the relation results using a predicate. */
  where(fn: (row: T) => boolean): RelationQueryBuilder<T>;
  /** Adds an ORDER BY clause. */
  orderBy(col: string, dir?: string): RelationQueryBuilder<T>;
  /** Limits the number of results returned. */
  limit(n: number): RelationQueryBuilder<T>;
  /** Skips the first `n` results. */
  offset(n: number): RelationQueryBuilder<T>;
  /** Projects each row to a new shape; return type preserves U so `select().toArray()` is typed as `U[]`. */
  select<U>(fn: (row: T) => U): RelationQueryBuilder<U>;
  /** Executes the query and returns all matching rows. */
  toArray(): Promise<T[]>;
  /** Executes the query and returns the first matching row, or `undefined`. */
  first(): Promise<T | undefined>;
  /** Executes the query and returns the row count. */
  count(): Promise<number>;
}

/** `'many'` for to-many relation types; `'one'` for to-one. */
export type RelationKind<TType extends RelationType> = TType extends "one-to-many" | "many-to-many"
  ? "many"
  : "one";

/** Resolved relation property type given entity class E and cardinality Kind.
 *  When the target entity has a custom queryBuilder class, its scope methods (e.g. archived())
 *  are exposed on the relation so they can be used in select/where callbacks and inlined by the transformer. */
export type RelatedEntityInstance<
  E extends AnyEntityClass,
  Kind extends "one" | "many",
> = Kind extends "many"
  ? E extends { queryBuilder: new (...args: any[]) => infer QB }
    ? QB & EntityInstance<E>[]
    : RelationQueryBuilder<SelectRow<E>> & EntityInstance<E>[]
  : SingleRelation<EntityInstance<E>>;

/** Array-shaped relation property that also exposes a `.query()` builder. */
export type ManyRelation<E extends EntityBase> = RelationQueryBuilder<E> & E[];
/** Singular relation property: the related entity instance directly (not wrapped in an array). */
export type SingleRelation<E extends EntityBase> = E;

/** Normalises E (entity class or instance type) to its instance type. */
export type ToEntityInstance<E> = E extends EntityBase ? E : EntityInstance<EntityClassOf<E>>;

/** Relation property type for one-to-many associations. Declare on entity subclasses. */
export type OneToMany<E extends AnyEntityClass | EntityBase> = E extends EntityBase
  ? ManyRelation<E>
  : RelatedEntityInstance<EntityClassOf<E>, "many">;
/** Relation property type for many-to-one associations. Declare on entity subclasses. */
export type ManyToOne<E extends AnyEntityClass | EntityBase> = SingleRelation<ToEntityInstance<E>>;
/** Relation property type for one-to-one associations. Declare on entity subclasses. */
export type OneToOne<E extends AnyEntityClass | EntityBase> = SingleRelation<ToEntityInstance<E>>;
/** Relation property type for many-to-many associations. Declare on entity subclasses. */
export type ManyToMany<E extends AnyEntityClass | EntityBase> = E extends EntityBase
  ? ManyRelation<E>
  : RelatedEntityInstance<EntityClassOf<E>, "many">;

/** @deprecated Prefer OneToMany<Post> with import type + EntityClassOf. Kept for backward compatibility. */
export type UntypedOneToMany = RelationQueryBuilder<SelectRow<any>> & EntityInstance<any>[];
/** @deprecated Prefer ManyToOne<Post> with import type + EntityClassOf. Kept for backward compatibility. */
export type UntypedManyToOne = RelationQueryBuilder<SelectRow<any>> & EntityInstance<any>;

/** Converts a `RelationDef` to its runtime queryable shape (array builder or single instance). */
export type RelationQueryable<R> =
  R extends RelationDef<infer E, infer TType>
    ? E extends AnyEntityClass
      ? RelatedEntityInstance<E, RelationKind<TType>>
      : TType extends "one-to-many" | "many-to-many"
        ? RelationQueryBuilder<E> & E[]
        : RelationQueryBuilder<E> & E
    : never;

function makeRelation<E, TType extends RelationType>(
  type: TType,
  target: () => unknown,
  options: RelationOptions | JunctionOptions,
): RelationDef<E, TType> {
  return { _relType: type, _target: target, _options: options } as RelationDef<E, TType>;
}

/** oneToOne: FK on this table; target is the other entity */
export function oneToOne<E extends AnyEntityClass>(
  target: () => E,
  options: RelationOptions,
): RelationDef<E, "one-to-one">;
/** oneToOne overload for generic target types (use with `import type` thunks). */
export function oneToOne<TTarget>(
  target: () => { _selectType: TTarget },
  options: RelationOptions,
): RelationDef<TTarget, "one-to-one">;
/** Manual typing: pass E explicitly when thunk is () => unknown (e.g. createRequire). Use with import type. */
export function oneToOne<E extends AnyEntityClass>(
  target: () => unknown,
  options: RelationOptions,
): RelationDef<E, "one-to-one">;
export function oneToOne(
  target: () => unknown,
  options: RelationOptions,
): RelationDef<unknown, "one-to-one"> {
  return makeRelation("one-to-one", target, options);
}

/** manyToOne: FK on this table. Pass a thunk (() => EntityClass) to handle circular imports. */
export function manyToOne<E extends AnyEntityClass>(
  target: () => E,
  options: RelationOptions,
): RelationDef<E, "many-to-one">;
/** manyToOne overload for generic target types (use with `import type` thunks). */
export function manyToOne<TTarget>(
  target: () => { _selectType: TTarget },
  options: RelationOptions,
): RelationDef<TTarget, "many-to-one">;
/** Manual typing: pass E explicitly when thunk is () => unknown (e.g. createRequire). Use with import type. */
export function manyToOne<E extends AnyEntityClass>(
  target: () => unknown,
  options: RelationOptions,
): RelationDef<E, "many-to-one">;
export function manyToOne(
  target: () => unknown,
  options: RelationOptions,
): RelationDef<unknown, "many-to-one"> {
  return makeRelation("many-to-one", target, options);
}

/** oneToMany: FK on target table. Pass a thunk (() => EntityClass) to handle circular imports. */
export function oneToMany<E extends AnyEntityClass>(
  target: () => E,
  options: { foreignKey: string | string[] },
): RelationDef<E, "one-to-many">;
/** oneToMany overload for generic target types (use with `import type` thunks). */
export function oneToMany<TTarget>(
  target: () => { _selectType: TTarget },
  options: { foreignKey: string | string[] },
): RelationDef<TTarget, "one-to-many">;
/** Manual typing: pass E explicitly when thunk is () => unknown (e.g. createRequire). Use with import type. */
export function oneToMany<E extends AnyEntityClass>(
  target: () => unknown,
  options: { foreignKey: string | string[] },
): RelationDef<E, "one-to-many">;
export function oneToMany(
  target: () => unknown,
  options: { foreignKey: string | string[] },
): RelationDef<unknown, "one-to-many"> {
  return makeRelation("one-to-many", target, options);
}

/** manyToMany: junction table with foreignKey and referenceKey */
export function manyToMany<E extends AnyEntityClass>(
  target: () => E,
  options: JunctionOptions,
): RelationDef<E, "many-to-many">;
/** manyToMany overload for generic target types (use with `import type` thunks). */
export function manyToMany<TTarget>(
  target: () => { _selectType: TTarget },
  options: JunctionOptions,
): RelationDef<TTarget, "many-to-many">;
/** Manual typing: pass E explicitly when thunk is () => unknown (e.g. createRequire). Use with import type. */
export function manyToMany<E extends AnyEntityClass>(
  target: () => unknown,
  options: JunctionOptions,
): RelationDef<E, "many-to-many">;
export function manyToMany(
  target: () => unknown,
  options: JunctionOptions,
): RelationDef<unknown, "many-to-many"> {
  return makeRelation("many-to-many", target, options);
}

/** Namespace object grouping all relation factory functions (`rel.oneToMany(…)`, etc.). */
export const rel = {
  oneToOne,
  manyToOne,
  oneToMany,
  manyToMany,
};
