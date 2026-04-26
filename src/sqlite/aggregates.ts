/**
 * SQLite-specific aggregate function stubs.
 * Import from "typhex/sqlite" to use these inside .select() and .having() lambdas.
 * These are never executed — the transformer/parser reads source text instead.
 */

const msg = (n: string) => `${n}() can only be used inside a .select() or .having() lambda`;

/** Concatenates grouped strings with optional separator. Compiles to GROUP_CONCAT. */
export function groupConcat(_field: unknown, _separator?: string): string {
  throw new Error(msg("groupConcat"));
}
