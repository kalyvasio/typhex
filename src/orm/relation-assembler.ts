/**
 * Relation assembler: attaches relation data onto rows.
 * Handles both flat JOIN columns (assembleJoined) and pre-fetched maps (assembleFetched).
 */

import type { IrSelect } from "../ir/types.js";
import type { RelationFetchMetadata } from "./relation-context-builder.js";
import { makeCompositeKey } from "./query-helpers.js";

/**
 * Reconstruct nested objects from flat JOIN columns
 * (e.g. author_name → row.author.name).
 */
export function assembleJoined(
  rows: Record<string, unknown>[],
  reusableJoinKeys: Set<string>,
  selectIr: IrSelect
): void {
  for (const relKey of reusableJoinKeys) {
    const { outputKey, subPaths, aliases } = collectJoinedSubPaths(relKey, selectIr);
    if (subPaths.length === 0) continue;
    for (const row of rows) {
      row[outputKey] = buildNestedObject(subPaths, aliases, row);
      for (const a of aliases) delete row[a];
    }
  }
}

/** Attach fetched relation maps onto rows. */
export function assembleFetched(
  rows: Record<string, unknown>[],
  fetches: RelationFetchMetadata[],
  fetched: Map<string, Map<string, unknown> | Map<string, unknown[]>>,
  skip: Set<string>
): void {
  for (const meta of fetches) {
    if (skip.has(meta.relation.name)) continue;
    const data = fetched.get(meta.relation.name);
    if (!data) continue;
    if (meta.isArray) {
      attachToManyRelation(rows, meta, data as Map<string, unknown[]>);
    } else {
      attachToOneRelation(rows, meta, data as Map<string, unknown>);
    }
  }
}

/** Gather the sub-field names and flat column aliases selected for a joined relation,
 *  scanning both `select.paths` (e.g. ["company","name"]) and `select.relations`
 *  (explicit relation entries with subPaths). Also resolves the outputKey. */
function collectJoinedSubPaths(
  relKey: string,
  selectIr: IrSelect
): { outputKey: string; subPaths: string[]; aliases: string[] } {
  const subPaths: string[] = [];
  const aliases: string[] = [];
  let outputKey = relKey;

  for (let i = 0; i < selectIr.paths.length; i++) {
    const path = selectIr.paths[i];
    if (path.length > 1 && path[0] === relKey) {
      subPaths.push(path[path.length - 1]);
      aliases.push(selectIr.aliases?.[i] ?? `${relKey}_${path[path.length - 1]}`);
    }
  }

  for (const r of selectIr.relations ?? []) {
    if (r.name === relKey && r.subPaths?.length) {
      outputKey = r.outputKey;
      for (const sub of r.subPaths) {
        if (sub.length > 0) {
          subPaths.push(sub[sub.length - 1]);
          aliases.push(`${r.outputKey}_${sub.join("_")}`);
        }
      }
    }
  }

  return { outputKey, subPaths, aliases };
}

/** Reconstruct a nested object `{ field: row[alias], ... }` from parallel
 *  sub-field names and flat alias arrays, reading values from the raw row. */
function buildNestedObject(
  subPaths: string[],
  aliases: string[],
  row: Record<string, unknown>
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < subPaths.length; i++) {
    obj[subPaths[i]] = row[aliases[i]];
  }
  return obj;
}

/** Set `row[outputKey]` to the array of related rows from `data`,
 *  looked up by the composite key of the parent's PK columns. */
function attachToManyRelation(
  rows: Record<string, unknown>[],
  meta: RelationFetchMetadata,
  data: Map<string, unknown[]>
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
  data: Map<string, unknown>
): void {
  for (const row of rows) {
    const key = makeCompositeKey(row, meta.fkColumns);
    row[meta.relation.outputKey] = data.get(key) ?? null;
  }
}
