/**
 * PostgreSQL-specific aggregate function stubs.
 * Import from "typhex/postgres" to use these inside .select() and .having() lambdas.
 * These are never executed — the transformer/parser reads source text instead.
 */

const msg = (n: string) => `${n}() can only be used inside a .select() or .having() lambda`;

/** Concatenates grouped strings with a required separator. Compiles to STRING_AGG. */
export function stringAgg(_field: unknown, _separator: string): string {
  throw new Error(msg("stringAgg"));
}

/** Collects values into a PostgreSQL array. Compiles to ARRAY_AGG. */
export function arrayAgg<T>(_field: T): T[] {
  throw new Error(msg("arrayAgg"));
}

/** Collects values into a JSON array. Compiles to JSON_AGG. */
export function jsonAgg(_field: unknown): unknown[] {
  throw new Error(msg("jsonAgg"));
}
