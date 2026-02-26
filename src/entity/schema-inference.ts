/**
 * Schema string inference: SQL-like column strings → TypeScript types.
 * Used by Entity(table, schema, relations) for InferTable and InferInsert.
 */

export type SQLTypeMap = {
  integer: number;
  int: number;
  smallint: number;
  tinyint: number;
  real: number;
  float: number;
  double: number;
  numeric: number;
  decimal: number;
  text: string;
  varchar: string;
  char: string;
  nvarchar: string;
  uuid: string;
  boolean: boolean;
  bool: boolean;
  date: Date;
  datetime: Date;
  timestamp: Date;
  blob: Uint8Array;
  json: unknown;
  jsonb: unknown;
  bigint: bigint;
};

/** Remove parenthesized part e.g. varchar(255) → varchar */
export type StripParens<S extends string> =
  S extends `${infer Base}(${string})${infer Rest}` ? `${Base}${Rest}` : S;

/** First token (base type) of schema string, lowercased */
export type ExtractSQLBase<S extends string> =
  StripParens<S> extends `${infer Base} ${string}`
    ? Lowercase<Base>
    : Lowercase<StripParens<S>>;

export type SQLToTS<S extends string> =
  ExtractSQLBase<S> extends keyof SQLTypeMap ? SQLTypeMap[ExtractSQLBase<S>] : unknown;

export type IsNotNull<S extends string> =
  Lowercase<S> extends `${string}not null${string}` ? true
  : Lowercase<S> extends `${string}primary key${string}` ? true
  : false;

export type IsGenerated<S extends string> =
  Lowercase<S> extends `${string}autoincrement${string}` ? true
  : Lowercase<S> extends `${string}auto_increment${string}` ? true
  : Lowercase<S> extends `${string}generated${string}` ? true
  : false;

/** Column has DEFAULT in schema → can be omitted on INSERT */
export type HasDefault<S extends string> =
  Lowercase<S> extends `${string}default${string}` ? true : false;

export type InferColumnType<S extends string> =
  IsNotNull<S> extends true ? SQLToTS<S> : SQLToTS<S> | null;

/** Strip readonly from all properties (const TSchema can make inferred types readonly). */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Inferred row type from schema: one type per column, all writable.
 * Represents a *full* row (all columns). When you select specific columns, the runtime
 * result has only those keys; the type system could use Pick<InferTable<TSchema>, "id" | "name">
 * for that in the future.
 */
export type InferTable<T extends Record<string, string>> = Mutable<{
  [K in keyof T]: InferColumnType<T[K]>;
}>;

/** Column can be omitted on INSERT (generated, nullable, or has default). */
type OptionalOnInsert<S extends string> =
  IsGenerated<S> extends true ? true
  : IsNotNull<S> extends false ? true
  : HasDefault<S> extends true ? true
  : false;

/**
 * Shape for INSERT / create(): generated, nullable, and default columns are optional.
 */
export type InferInsert<T extends Record<string, string>> = Mutable<
  { [K in keyof T as OptionalOnInsert<T[K]> extends true ? K : never]?: InferColumnType<T[K]> } &
  { [K in keyof T as OptionalOnInsert<T[K]> extends true ? never : K]: InferColumnType<T[K]> }
>;
