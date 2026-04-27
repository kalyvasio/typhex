/**
 * Aggregate function stubs for use inside .select() and .having() lambdas.
 * These are never executed at runtime — the TypeScript transformer replaces them
 * at compile time, and the runtime parser reads source text via acorn.
 * Calling them directly outside a lambda throws a clear error.
 */

const msg = (n: string) => `${n}() can only be used inside a .select() or .having() lambda`;

/** Returns the count of rows matching the query. Use inside `.select()` or `.having()` lambdas. */
export function count(_field?: unknown): number {
  throw new Error(msg("count"));
}

/** Returns the sum of the given numeric field. Use inside `.select()` or `.having()` lambdas. */
export function sum(_field: number): number {
  throw new Error(msg("sum"));
}

/** Returns the average of the given numeric field. Use inside `.select()` or `.having()` lambdas. */
export function avg(_field: number): number {
  throw new Error(msg("avg"));
}

/** Returns the minimum value of the given field. Use inside `.select()` or `.having()` lambdas. */
export function min<T>(_field: T): T {
  throw new Error(msg("min"));
}

/** Returns the maximum value of the given field. Use inside `.select()` or `.having()` lambdas. */
export function max<T>(_field: T): T {
  throw new Error(msg("max"));
}

/** Marks a field as DISTINCT inside an aggregate: count(distinct(p.category)). */
export function distinct<T>(_field: T): T {
  throw new Error(msg("distinct"));
}
