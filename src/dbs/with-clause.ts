/**
 * Build WITH (CTE) prefixes and merge bound parameters for nested SELECT bodies.
 */

import type { WithClause } from "./types.js";

function quoteId(name: string): string {
  return '"' + String(name).replaceAll('"', '""') + '"';
}

/** Shift $n placeholders in Postgres SQL by adding delta to each index. */
export function shiftPostgresPlaceholders(sql: string, delta: number): string {
  if (delta === 0) return sql;
  return sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + delta}`);
}

/** Prepend WITH clause(s) to a core statement; merge params as [cte1..., cte2..., core...]. */
export function wrapWithPostgres(
  coreSql: string,
  coreParams: unknown[],
  withClauses: WithClause[] | undefined
): { sql: string; params: unknown[] } {
  if (!withClauses?.length) return { sql: coreSql, params: coreParams };
  const esc = quoteId;
  let offset = 0;
  const merged: unknown[] = [];
  const parts: string[] = [];
  for (const w of withClauses) {
    parts.push(`${esc(w.name)} AS (${shiftPostgresPlaceholders(w.bodySql, offset)})`);
    merged.push(...w.bodyParams);
    offset += w.bodyParams.length;
  }
  const outer = shiftPostgresPlaceholders(coreSql, offset);
  merged.push(...coreParams);
  return { sql: `WITH ${parts.join(", ")} ${outer}`, params: merged };
}

/** SQLite: same param ordering; no placeholder renumbering in SQL text. */
export function wrapWithSqlite(
  coreSql: string,
  coreParams: unknown[],
  withClauses: WithClause[] | undefined
): { sql: string; params: unknown[] } {
  if (!withClauses?.length) return { sql: coreSql, params: coreParams };
  const esc = quoteId;
  const merged: unknown[] = [];
  for (const w of withClauses) merged.push(...w.bodyParams);
  merged.push(...coreParams);
  const parts = withClauses.map((w) => `${esc(w.name)} AS (${w.bodySql})`).join(", ");
  return { sql: `WITH ${parts} ${coreSql}`, params: merged };
}
