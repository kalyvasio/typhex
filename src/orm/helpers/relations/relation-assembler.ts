/**
 * Relation assembler: attaches relation data onto rows.
 * Handles both flat JOIN columns (assembleJoined) and pre-fetched maps (assembleFetched).
 */

import type { JoinedProjection, RelationFetchMetadata } from "../../query-plan.js";
import { makeCompositeKey } from "../../query-helpers.js";

/**
 * Reconstruct nested objects from flat JOIN columns
 * (e.g. author_name → row.author.name) using pre-extracted projections.
 */
export function assembleJoined(
  rows: Record<string, unknown>[],
  projections: JoinedProjection[],
): void {
  for (const proj of projections) {
    if (proj.members.length === 0) continue;
    for (const row of rows) {
      const obj: Record<string, unknown> = {};
      for (const m of proj.members) obj[m.subPath] = row[m.alias];
      row[proj.outputKey] = obj;
      for (const m of proj.members) delete row[m.alias];
    }
  }
}

/** Attach fetched relation maps onto rows. */
export function assembleFetched(
  rows: Record<string, unknown>[],
  fetches: RelationFetchMetadata[],
  fetched: Map<string, Map<string, unknown> | Map<string, unknown[]>>,
  skip: Set<string>,
): void {
  for (const meta of fetches) {
    if (skip.has(meta.relation.name)) continue;
    const data = fetched.get(meta.relation.name);
    if (!data) continue;
    if (meta.relationType === "one-to-many" || meta.relationType === "many-to-many") {
      attachToManyRelation(rows, meta, data as Map<string, unknown[]>);
    } else {
      attachToOneRelation(rows, meta, data as Map<string, unknown>);
    }
  }
}

/** Set `row[outputKey]` to the array of related rows from `data`,
 *  looked up by the composite key of the parent's PK columns. */
function attachToManyRelation(
  rows: Record<string, unknown>[],
  meta: RelationFetchMetadata,
  data: Map<string, unknown[]>,
): void {
  const pkCols = meta.parentPkColumns ?? ["id"];
  for (const row of rows) {
    const key = makeCompositeKey(row, pkCols);
    row[meta.relation.outputKey] = data.get(key) ?? [];
  }
}

/** Set `row[outputKey]` to the single related row from `data`,
 *  looked up by the composite key of the row's FK columns, or null if unmatched. */
function attachToOneRelation(
  rows: Record<string, unknown>[],
  meta: RelationFetchMetadata,
  data: Map<string, unknown>,
): void {
  for (const row of rows) {
    const key = makeCompositeKey(row, meta.fkColumns);
    row[meta.relation.outputKey] = data.get(key) ?? null;
  }
}
