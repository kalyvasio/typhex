/**
 * Aggregate function stubs for use inside .select() and .having() lambdas.
 * These are never executed at runtime — the TypeScript transformer replaces them
 * at compile time, and the runtime parser reads source text via acorn.
 * Calling them directly outside a lambda throws a clear error.
 */

const msg = (n: string) => `${n}() can only be used inside a .select() or .having() lambda`;

export function count(_field?: unknown): number {
  throw new Error(msg("count"));
}
export function sum(_field: number): number {
  throw new Error(msg("sum"));
}
export function avg(_field: number): number {
  throw new Error(msg("avg"));
}
export function min<T>(_field: T): T {
  throw new Error(msg("min"));
}
export function max<T>(_field: T): T {
  throw new Error(msg("max"));
}
/** Marks a field as DISTINCT inside an aggregate: count(distinct(p.category)). */
export function distinct<T>(_field: T): T {
  throw new Error(msg("distinct"));
}
