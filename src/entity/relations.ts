/**
 * Relation definitions for Entity(table, schema, relations).
 * Target is a thunk (() => EntityClass) that defers evaluation for circular imports.
 */
import type { AnyEntityClass, EntityClassOf, EntityInstance, SelectRow } from "./entity.js";
import type { EntityBase } from "./types.js";

export type RelationType =
  | "one-to-one"
  | "many-to-one"
  | "one-to-many"
  | "many-to-many";

export interface RelationOptions {
  foreignKey: string;
  references?: string;
}

export interface JunctionOptions {
  junction: string;
  foreignKey: string;
  referenceKey: string;
}

/** E is the target entity class (for display as RelatedEntityInstance<E>) or legacy instance type. */
export interface RelationDef<E = unknown, TType extends RelationType = RelationType> {
  readonly _relType: TType;
  readonly _target: () => unknown;
  readonly _options: RelationOptions | JunctionOptions;
}

/** Type aliases for manual relation typing when inference fails (e.g. circular refs). Use with import type + generic: rel.oneToMany<Post>(() => _require("./post.js").Post, opts). */
export type OneToOneDef<E> = RelationDef<E, "one-to-one">;
export type ManyToOneDef<E> = RelationDef<E, "many-to-one">;
export type OneToManyDef<E> = RelationDef<E, "one-to-many">;
export type ManyToManyDef<E> = RelationDef<E, "many-to-many">;

export type RelationsMap = Record<string, RelationDef<any, RelationType>>;

/** Read-only query builder type for relations (no insert/update/delete/patch/save). */
export interface RelationQueryBuilder<T> {
  query(): RelationQueryBuilder<T>;
  where(fn: (row: T) => boolean): RelationQueryBuilder<T>;
  orderBy(col: string, dir?: string): RelationQueryBuilder<T>;
  limit(n: number): RelationQueryBuilder<T>;
  offset(n: number): RelationQueryBuilder<T>;
  /** Return type preserves projected shape U so select().toArray() result types u.posts as U[]. */
  select<U>(fn: (row: T) => U): RelationQueryBuilder<U>;
  toArray(): Promise<T[]>;
  first(): Promise<T | undefined>;
  count(): Promise<number>;
}

/** "one" = single instance + .query(), "many" = array + .query() */
export type RelationKind<TType extends RelationType> =
  TType extends "one-to-many" | "many-to-many" ? "many" : "one";

/** Relation property type: .query() returns RelationQueryBuilder; value is single instance or array. Row type is SelectRow so nested relations (e.g. p.comments) have .query(). */
export type RelatedEntityInstance<E extends AnyEntityClass, Kind extends "one" | "many"> =
  Kind extends "many"
    ? RelationQueryBuilder<SelectRow<E>> & EntityInstance<E>[]
    : SingleRelation<EntityInstance<E>>;

/** Instance-type relation aliases: cleaner display than RelationQueryBuilder<E> & E[]. Use when E extends EntityBase. */
export type ManyRelation<E extends EntityBase> = RelationQueryBuilder<E> & E[];
/** Single relation: entity instance; author.query() returns SingleRowQueryBuilder (has patch). */
export type SingleRelation<E extends EntityBase> = E;

/** Normalize E (class or instance) to instance type for relation props. */
type ToEntityInstance<E> = E extends EntityBase ? E : EntityInstance<EntityClassOf<E>>;

/** Relation property types for declare on subclass. E can be entity class (typeof Post) or instance type (Post) when using import type. */
/** When E extends EntityBase (instance type): use ManyRelation/SingleRelation so .query() yields RelationQueryBuilder<E>. EntityClassOf can resolve to AnyEntityClass in circular refs. */
export type OneToMany<E extends AnyEntityClass | EntityBase> =
  E extends EntityBase ? ManyRelation<E> : RelatedEntityInstance<EntityClassOf<E>, "many">;
export type ManyToOne<E extends AnyEntityClass | EntityBase> = SingleRelation<ToEntityInstance<E>>;
export type OneToOne<E extends AnyEntityClass | EntityBase> = SingleRelation<ToEntityInstance<E>>;
export type ManyToMany<E extends AnyEntityClass | EntityBase> =
  E extends EntityBase ? ManyRelation<E> : RelatedEntityInstance<EntityClassOf<E>, "many">;

/** @deprecated Prefer OneToMany<Post> with import type + EntityClassOf. Kept for backward compatibility. */
export type UntypedOneToMany = RelationQueryBuilder<SelectRow<any>> & EntityInstance<any>[];
/** @deprecated Prefer ManyToOne<Post> with import type + EntityClassOf. Kept for backward compatibility. */
export type UntypedManyToOne = RelationQueryBuilder<SelectRow<any>> & EntityInstance<any>;

/** Resolve the queryable type for a relation. Uses RelatedEntityInstance when target is entity class. */
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
  options: RelationOptions | JunctionOptions
): RelationDef<E, TType> {
  return { _relType: type, _target: target, _options: options } as RelationDef<E, TType>;
}

/** oneToOne: FK on this table; target is the other entity */
export function oneToOne<E extends AnyEntityClass>(
  target: () => E,
  options: RelationOptions
): RelationDef<E, "one-to-one">;
export function oneToOne<TTarget>(
  target: () => { _selectType: TTarget },
  options: RelationOptions
): RelationDef<TTarget, "one-to-one">;
/** Manual typing: pass E explicitly when thunk is () => unknown (e.g. createRequire). Use with import type. */
export function oneToOne<E extends AnyEntityClass>(
  target: () => unknown,
  options: RelationOptions
): RelationDef<E, "one-to-one">;
export function oneToOne(
  target: () => unknown,
  options: RelationOptions
): RelationDef<unknown, "one-to-one"> {
  return makeRelation("one-to-one", target, options);
}

/** manyToOne: FK on this table. Pass a thunk (() => EntityClass) to handle circular imports. */
export function manyToOne<E extends AnyEntityClass>(
  target: () => E,
  options: RelationOptions
): RelationDef<E, "many-to-one">;
export function manyToOne<TTarget>(
  target: () => { _selectType: TTarget },
  options: RelationOptions
): RelationDef<TTarget, "many-to-one">;
/** Manual typing: pass E explicitly when thunk is () => unknown (e.g. createRequire). Use with import type. */
export function manyToOne<E extends AnyEntityClass>(
  target: () => unknown,
  options: RelationOptions
): RelationDef<E, "many-to-one">;
export function manyToOne(
  target: () => unknown,
  options: RelationOptions
): RelationDef<unknown, "many-to-one"> {
  return makeRelation("many-to-one", target, options);
}

/** oneToMany: FK on target table. Pass a thunk (() => EntityClass) to handle circular imports. */
export function oneToMany<E extends AnyEntityClass>(
  target: () => E,
  options: { foreignKey: string }
): RelationDef<E, "one-to-many">;
export function oneToMany<TTarget>(
  target: () => { _selectType: TTarget },
  options: { foreignKey: string }
): RelationDef<TTarget, "one-to-many">;
/** Manual typing: pass E explicitly when thunk is () => unknown (e.g. createRequire). Use with import type. */
export function oneToMany<E extends AnyEntityClass>(
  target: () => unknown,
  options: { foreignKey: string }
): RelationDef<E, "one-to-many">;
export function oneToMany(
  target: () => unknown,
  options: { foreignKey: string }
): RelationDef<unknown, "one-to-many"> {
  return makeRelation("one-to-many", target, options);
}

/** manyToMany: junction table with foreignKey and referenceKey */
export function manyToMany<E extends AnyEntityClass>(
  target: () => E,
  options: JunctionOptions
): RelationDef<E, "many-to-many">;
export function manyToMany<TTarget>(
  target: () => { _selectType: TTarget },
  options: JunctionOptions
): RelationDef<TTarget, "many-to-many">;
/** Manual typing: pass E explicitly when thunk is () => unknown (e.g. createRequire). Use with import type. */
export function manyToMany<E extends AnyEntityClass>(
  target: () => unknown,
  options: JunctionOptions
): RelationDef<E, "many-to-many">;
export function manyToMany(
  target: () => unknown,
  options: JunctionOptions
): RelationDef<unknown, "many-to-many"> {
  return makeRelation("many-to-many", target, options);
}

export const rel = {
  oneToOne,
  manyToOne,
  oneToMany,
  manyToMany,
};
