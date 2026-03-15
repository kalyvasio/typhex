/**
 * Relation fetcher: fetches related entities via WHERE IN queries.
 * Does NOT mutate rows — returns fetched data as maps.
 */

import type { Driver } from "../driver/types.js";
import type { RelationFetchMetadata } from "./relation-context-builder.js";
import { whereColumnIn, whereAnd } from "./query-helpers.js";

/** Run one WHERE IN query per pending relation fetch and collect results into keyed maps.
 *  Skips relations in `skip` (already loaded via JOIN).
 *  Returns a map from relation name to either a to-one index (Map by PK)
 *  or a to-many grouping (Map by FK). */
export async function fetchRelations(
  driver: Driver,
  rows: Record<string, unknown>[],
  fetches: RelationFetchMetadata[],
  skip: Set<string>
): Promise<Map<string, Map<unknown, unknown> | Map<unknown, unknown[]>>> {
  const result = new Map<string, Map<unknown, unknown> | Map<unknown, unknown[]>>();
  for (const meta of fetches) {
    if (skip.has(meta.relation.name)) continue;
    if (meta.isArray) {
      const ids = collectUniqueValues(rows, "id");
      if (ids.length === 0) { result.set(meta.relation.name, new Map()); continue; }
      const related = await buildRelatedQuery(meta, driver, meta.fkColumn, ids, meta.fkColumn);
      result.set(meta.relation.name, groupByKey(related, meta.fkColumn));
    } else {
      const ids = collectUniqueValues(rows, meta.fkColumn);
      if (ids.length === 0) { result.set(meta.relation.name, new Map()); continue; }
      const related = await buildRelatedQuery(meta, driver, meta.targetPk, ids, meta.targetPk);
      result.set(meta.relation.name, indexByKey(related, meta.targetPk));
    }
  }
  return result;
}

/** Extract distinct non-null values of `column` from the result rows
 *  to build the IN list for the follow-up query. */
function collectUniqueValues(rows: Record<string, unknown>[], column: string): unknown[] {
  return [...new Set(rows.map((r) => r[column]).filter((v) => v != null))];
}

/** Construct and execute the WHERE IN query for a single relation,
 *  applying any sub-select projection, ordering, limit, and offset
 *  from the relation IR. The anchor column is always included in the
 *  SELECT list so rows can be correlated back to their parents. */
async function buildRelatedQuery(
  meta: RelationFetchMetadata,
  driver: Driver,
  whereInColumn: string,
  ids: unknown[],
  anchorColumn: string
): Promise<unknown[]> {
  const baseWhere = whereColumnIn(whereInColumn, ids as number[]);
  const whereIr = meta.relation.whereIr ? whereAnd(baseWhere, meta.relation.whereIr) : baseWhere;

  let chain = meta.targetEntity.query(driver).where(whereIr, meta.relation.whereParams ?? {});
  for (const o of meta.relation.orderBy ?? []) chain = chain.orderBy(o.path[0] ?? "", o.direction);
  if (meta.relation.limitNum != null) chain = chain.limit(meta.relation.limitNum);
  if (meta.relation.offsetNum != null) chain = chain.offset(meta.relation.offsetNum);
  if (meta.relation.subPaths && meta.relation.subPaths.length > 0) {
    const cols = meta.relation.subPaths.map((p) => p[0] ?? p).flat();
    if (!cols.includes(anchorColumn)) cols.push(anchorColumn);
    chain = chain.select(cols);
  }

  return chain.toArray();
}

/** Index rows by `key` into a Map for O(1) to-one lookups (keyed by the relation's target PK). */
function indexByKey(rows: unknown[], key: string): Map<unknown, unknown> {
  const map = new Map<unknown, unknown>();
  for (const r of rows) {
    const k = (r as Record<string, unknown>)[key];
    if (k !== undefined) map.set(k, r);
  }
  return map;
}

/** Group rows by `key` into a Map of arrays for O(1) to-many lookups (keyed by the FK column). */
function groupByKey(rows: unknown[], key: string): Map<unknown, unknown[]> {
  const map = new Map<unknown, unknown[]>();
  for (const r of rows) {
    const k = (r as Record<string, unknown>)[key];
    if (k !== undefined) {
      const arr = map.get(k) ?? [];
      arr.push(r);
      map.set(k, arr);
    }
  }
  return map;
}
