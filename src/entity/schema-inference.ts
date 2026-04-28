/**
 * Schema string inference: SQL-like column strings → TypeScript types.
 * Used by Entity(table, schema, relations) for InferTable and InferInsert.
 */

/** Lookup table from SQL type names to their TypeScript primitive equivalents. */
export type SQLTypeMap = {
  integer: number;
  int: number;
  serial: number;
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
  bigserial: bigint;
};

/** Removes parenthesised precision suffixes (e.g. `varchar(255)` → `varchar`). */
export type StripParens<S extends string> = S extends `${infer Base}(${string})${infer Rest}`
  ? `${Base}${Rest}`
  : S;

/** Extracts the lowercased base SQL type from a column string (strips modifiers and precision). */
export type ExtractSQLBase<S extends string> =
  StripParens<S> extends `${infer Base} ${string}` ? Lowercase<Base> : Lowercase<StripParens<S>>;

/** Maps a SQL base type string to its TypeScript equivalent (e.g. `'integer'` → `number`). */
export type SQLToTS<S extends string> =
  ExtractSQLBase<S> extends keyof SQLTypeMap ? SQLTypeMap[ExtractSQLBase<S>] : unknown;

/** `true` when column string S is NOT NULL or PRIMARY KEY. */
export type IsNotNull<S extends string> =
  Lowercase<S> extends `${string}not null${string}`
    ? true
    : Lowercase<S> extends `${string}primary key${string}`
      ? true
      : false;

/** `true` when column string S is autoincrement, serial, or generated. */
export type IsGenerated<S extends string> =
  Lowercase<S> extends `${string}autoincrement${string}`
    ? true
    : Lowercase<S> extends `${string}auto_increment${string}`
      ? true
      : Lowercase<S> extends `${string}generated${string}`
        ? true
        : Lowercase<ExtractSQLBase<S>> extends "serial" | "bigserial"
          ? true
          : false;

/** `true` when column string S contains a DEFAULT clause. */
export type HasDefault<S extends string> =
  Lowercase<S> extends `${string}default${string}` ? true : false;

/** TypeScript type for a single schema column string S; includes `| null` when nullable. */
export type InferColumnType<S extends string> =
  IsNotNull<S> extends true ? SQLToTS<S> : SQLToTS<S> | null;

/** Forces TypeScript to expand an intersection/mapped type into a flat object for readable tooltips. */
export type Flatten<T> = { [K in keyof T]: T[K] } & {};

/** Removes `readonly` from all properties of T. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Materialized field types from schema strings (id: number, name: string, etc.). */
export type Materialized<T extends Record<string, string>> = Mutable<{
  readonly [K in keyof T]: InferColumnType<T[K]>;
}>;

/** Accepts either schema literal strings or an already-materialized shape; returns the materialized form. */
export type MaterializeShape<T extends Record<string, unknown>> =
  T extends Record<string, string> ? Materialized<T> : Mutable<T>;

/**
 * Inferred row type from schema: one type per column, all writable.
 */
export type InferTable<T extends Record<string, string>> = Flatten<{
  -readonly [K in keyof T]: InferColumnType<T[K]>;
}>;

/** `true` when a column may be omitted on INSERT (generated, nullable, or has DEFAULT). */
export type OptionalOnInsert<S extends string> =
  IsGenerated<S> extends true
    ? true
    : IsNotNull<S> extends false
      ? true
      : HasDefault<S> extends true
        ? true
        : false;

/**
 * Shape for INSERT / create(): generated, nullable, and default columns are optional.
 */
export type InferInsert<T extends Record<string, string>> = Flatten<
  {
    -readonly [K in keyof T as OptionalOnInsert<T[K]> extends true ? K : never]?: InferColumnType<
      T[K]
    >;
  } & {
    -readonly [K in keyof T as OptionalOnInsert<T[K]> extends true ? never : K]: InferColumnType<
      T[K]
    >;
  }
>;
