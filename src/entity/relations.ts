/**
 * Relation definitions for Entity(table, schema, relations).
 * Target is always a thunk to support circular relations.
 */

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

export interface RelationDef<TTarget = unknown, TType extends RelationType = RelationType> {
  readonly _relType: TType;
  readonly _target: () => { _selectType: TTarget };
  readonly _options: RelationOptions | JunctionOptions;
}

export type RelationsMap = Record<string, RelationDef<unknown, RelationType>>;

/** Result type for a loaded relation: single or array */
export type RelationResult<R> =
  R extends RelationDef<infer T, "one-to-many" | "many-to-many"> ? T[]
  : R extends RelationDef<infer T, RelationType> ? T
  : never;

function makeRelation<TTarget, TType extends RelationType>(
  type: TType,
  target: () => { _selectType: TTarget },
  options: RelationOptions | JunctionOptions
): RelationDef<TTarget, TType> {
  return {
    _relType: type,
    _target: target,
    _options: options,
  } as RelationDef<TTarget, TType>;
}

/** oneToOne: FK on this table; target is the other entity */
export function oneToOne<TTarget>(
  target: () => { _selectType: TTarget },
  options: RelationOptions
): RelationDef<TTarget, "one-to-one"> {
  return makeRelation("one-to-one", target, options);
}

/** manyToOne: FK on this table */
export function manyToOne<TTarget>(
  target: () => { _selectType: TTarget },
  options: RelationOptions
): RelationDef<TTarget, "many-to-one"> {
  return makeRelation("many-to-one", target, options);
}

/** oneToMany: FK on target table */
export function oneToMany<TTarget>(
  target: () => { _selectType: TTarget },
  options: { foreignKey: string }
): RelationDef<TTarget, "one-to-many"> {
  return makeRelation("one-to-many", target, options);
}

/** manyToMany: junction table with foreignKey and referenceKey */
export function manyToMany<TTarget>(
  target: () => { _selectType: TTarget },
  options: JunctionOptions
): RelationDef<TTarget, "many-to-many"> {
  return makeRelation("many-to-many", target, options);
}

export const rel = {
  oneToOne,
  manyToOne,
  oneToMany,
  manyToMany,
};
