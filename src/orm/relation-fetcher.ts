/**
 * Relation fetcher: fetches related entities via WHERE IN queries.
 * Does NOT mutate rows — returns fetched data as maps.
 */

import type { QueryExecutor } from "./db.js";
import type { RelationFetchMetadata } from "./relation-context-builder.js";
import type { IrNode } from "../ir/types.js";
import { whereAnd, makeCompositeKey, buildFetchByIdIr } from "./query-helpers.js";

/** Run one WHERE IN query per pending relation fetch and collect results into keyed maps.
 *  Skips relations in `skip` (already loaded via JOIN).
 *  Returns a map from relation name to either a to-one index (Map by PK)
 *  or a to-many grouping (Map by FK). */
export async function fetchRelations(
  qe: QueryExecutor,
  rows: Record<string, unknown>[],
  fetches: RelationFetchMetadata[],
  skip: Set<string>
): Promise<Map<string, Map<string, unknown> | Map<string, unknown[]>>> {
  const result = new Map<string, Map<string, unknown> | Map<string, unknown[]>>();
  for (const meta of fetches) {
    if (skip.has(meta.relation.name)) continue;
    if (meta.isArray) {
      const parentPkCols = meta.parentPkColumns ?? ["id"];
      const baseWhere = buildFetchByIdIr(rows, parentPkCols, meta.fkColumns);
      if (!baseWhere) { result.set(meta.relation.name, new Map()); continue; }
      const related = await buildRelatedQuery(meta, qe, baseWhere, meta.fkColumns);
      result.set(meta.relation.name, groupByCompositeKey(related, meta.fkColumns));
    } else {
      const baseWhere = buildFetchByIdIr(rows, meta.fkColumns, meta.targetPkColumns);
      if (!baseWhere) { result.set(meta.relation.name, new Map()); continue; }
      const related = await buildRelatedQuery(meta, qe, baseWhere, meta.targetPkColumns);
      result.set(meta.relation.name, indexByCompositeKey(related, meta.targetPkColumns));
    }
  }
  return result;
}

/** Construct and execute the WHERE query for a single relation,
 *  applying any sub-select projection, ordering, limit, and offset
 *  from the relation IR. All anchor columns are included in the SELECT
 *  list so rows can be correlated back to their parents by composite key. */
async function buildRelatedQuery(
  meta: RelationFetchMetadata,
  qe: QueryExecutor,
  baseWhere: IrNode,
  anchorColumns: string[]
): Promise<unknown[]> {
  const whereIr = meta.relation.whereIr ? whereAnd(baseWhere, meta.relation.whereIr) : baseWhere;

  let chain = meta.targetEntity.query(qe).where(whereIr, meta.relation.whereParams ?? {});
  for (const o of meta.relation.orderBy ?? []) chain = chain.orderBy(o.path[0] ?? "", o.direction);
  if (meta.relation.limitNum != null) chain = chain.limit(meta.relation.limitNum);
  if (meta.relation.offsetNum != null) chain = chain.offset(meta.relation.offsetNum);
  if (meta.relation.subPaths && meta.relation.subPaths.length > 0) {
    const cols = meta.relation.subPaths.map((p) => p[0] ?? p).flat();
    for (const col of anchorColumns) {
      if (!cols.includes(col)) cols.push(col);
    }
    chain = chain.select(cols);
  }

  return chain.toArray();
}

/** Index rows by composite key for O(1) to-one lookups (keyed by target PK columns). */
function indexByCompositeKey(rows: unknown[], keys: string[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const r of rows) {
    const k = makeCompositeKey(r as Record<string, unknown>, keys);
    map.set(k, r);
  }
  return map;
}

/** Group rows by composite key for O(1) to-many lookups (keyed by FK columns). */
function groupByCompositeKey(rows: unknown[], keys: string[]): Map<string, unknown[]> {
  const map = new Map<string, unknown[]>();
  for (const r of rows) {
    const k = makeCompositeKey(r as Record<string, unknown>, keys);
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  return map;
}
