/**
 * Relation fetcher: fetches related entities via WHERE IN queries.
 * Does NOT mutate rows — returns fetched data as maps.
 */

import type { QueryExecutor } from "../../db.js";
import type { RelationFetchMetadata } from "../query-plan/query-plan.js";
import type { IrSelectRelation } from "../../../ir/types.js";
import { whereAnd, makeCompositeKey, buildFetchByIdIr } from "../../query-helpers.js";
import { getEntityByTableName } from "../../../entity/global-driver.js";
import type { AnyEntityClass } from "../../../entity/entity.js";
import { groupBy } from "../../../utils.js";

/** Run one WHERE IN query per pending relation fetch and collect results into keyed maps.
 *  Skips relations in `skip` (already loaded via JOIN).
 *  Returns a map from relation name to either a to-one index (Map by PK)
 *  or a to-many grouping (Map by FK). */
export async function fetchRelations(
  qe: QueryExecutor,
  rows: Record<string, unknown>[],
  fetches: RelationFetchMetadata[],
  skip: Set<string>,
): Promise<Map<string, Map<string, unknown> | Map<string, unknown[]>>> {
  const result = new Map<string, Map<string, unknown> | Map<string, unknown[]>>();
  for (const meta of fetches) {
    if (skip.has(meta.relation.name)) continue;
    switch (meta.relationType) {
      case "many-to-many":
        result.set(meta.relation.name, await fetchManyToMany(qe, meta, rows));
        break;
      case "one-to-many":
        result.set(meta.relation.name, await fetchOneToMany(qe, meta, rows));
        break;
      default:
        result.set(meta.relation.name, await fetchOneToOne(qe, meta, rows));
    }
  }
  return result;
}

/** Fetch a to-many relation: WHERE IN on FK columns, grouped by FK composite key. */
async function fetchOneToMany(
  qe: QueryExecutor,
  meta: RelationFetchMetadata,
  rows: Record<string, unknown>[],
): Promise<Map<string, unknown[]>> {
  const parentPkCols = meta.parentPkColumns ?? ["id"];
  const related = await fetchRows(
    qe,
    rows,
    parentPkCols,
    meta.fkColumns,
    meta.targetEntity,
    meta.relation,
  );
  return groupByCompositeKey(related, meta.fkColumns);
}

/** Fetch a to-one relation: WHERE IN on FK→target-PK, indexed by target PK composite key. */
async function fetchOneToOne(
  qe: QueryExecutor,
  meta: RelationFetchMetadata,
  rows: Record<string, unknown>[],
): Promise<Map<string, unknown>> {
  const related = await fetchRows(
    qe,
    rows,
    meta.fkColumns,
    meta.targetPkColumns,
    meta.targetEntity,
    meta.relation,
  );
  return indexByCompositeKey(related, meta.targetPkColumns);
}

/** Many-to-many: two fetchRows calls through the junction, grouped by parent composite key. */
async function fetchManyToMany(
  qe: QueryExecutor,
  meta: RelationFetchMetadata,
  rows: Record<string, unknown>[],
): Promise<Map<string, unknown[]>> {
  const j = meta.junction!;
  const parentPkCols = meta.parentPkColumns ?? ["id"];

  const out = new Map<string, unknown[]>();
  for (const row of rows) out.set(makeCompositeKey(row, parentPkCols), []);

  // Step 1: parent rows → junction rows (no user relation options)
  const junctionEntity = getEntityByTableName(j.table) as AnyEntityClass;

  const junctionRows = (await fetchRows(
    qe,
    rows,
    parentPkCols,
    j.foreignKey,
    junctionEntity,
  )) as Record<string, unknown>[];
  if (junctionRows.length === 0) return out;

  // Step 2: junction rows → target entities (with user relation options)
  const related = await fetchRows(
    qe,
    junctionRows,
    j.referenceKey,
    meta.targetPkColumns,
    meta.targetEntity,
    meta.relation,
  );
  // Build targetKey → [parentKeys] from junction rows so we can iterate
  // `related` in fetch order (preserving any orderBy applied to the relation).
  const targetToParents = new Map<string, string[]>();
  for (const jr of junctionRows) {
    const parentKey = makeCompositeKey(remapCols(jr, j.foreignKey, parentPkCols), parentPkCols);
    const targetKey = makeCompositeKey(
      remapCols(jr, j.referenceKey, meta.targetPkColumns),
      meta.targetPkColumns,
    );
    const arr = targetToParents.get(targetKey) ?? [];
    arr.push(parentKey);
    targetToParents.set(targetKey, arr);
  }

  // Append each target to its parent array(s) in the order they were fetched.
  for (const target of related) {
    const targetKey = makeCompositeKey(target as Record<string, unknown>, meta.targetPkColumns);
    for (const parentKey of targetToParents.get(targetKey) ?? []) {
      const arr = out.get(parentKey) ?? [];
      arr.push(target);
      out.set(parentKey, arr);
    }
  }
  return out;
}

/** Batch-fetch rows from `entity` by mapping `srcCols` values from `srcRows` onto `tgtCols`
 *  via AND-of-INs. Applies user relation options (ordering, limit, subPath projection) when
 *  `rel` is provided. Returns flat rows — callers group/index as needed. */
async function fetchRows(
  qe: QueryExecutor,
  srcRows: Record<string, unknown>[],
  srcCols: string[],
  tgtCols: string[],
  entity: AnyEntityClass,
  rel?: IrSelectRelation,
): Promise<unknown[]> {
  const baseWhere = buildFetchByIdIr(srcRows, srcCols, tgtCols);
  if (!baseWhere) return [];

  const whereIr = rel?.whereIr ? whereAnd(baseWhere, rel.whereIr) : baseWhere;
  let chain = entity.query(qe).where(whereIr, rel?.whereParams ?? {});
  for (const o of rel?.orderBy ?? []) {
    const col = o.expr.kind === "member" ? (o.expr.path[0] ?? "") : "";
    chain = chain.orderBy(col, o.direction);
  }
  if (rel?.limitNum != null) chain = chain.limit(rel.limitNum);
  if (rel?.offsetNum != null) chain = chain.offset(rel.offsetNum);
  if (rel?.subPaths && rel.subPaths.length > 0) {
    const cols = rel.subPaths.flatMap((p) => p[0] ?? p);
    for (const col of tgtCols) {
      if (!cols.includes(col)) cols.push(col);
    }
    chain = chain.select(cols);
  }

  return chain.toArray();
}

/** Remap column values from a junction row onto a new column namespace for makeCompositeKey. */
function remapCols(
  row: Record<string, unknown>,
  from: string[],
  to: string[],
): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (let i = 0; i < to.length; i++) r[to[i]] = row[from[i] ?? from[0]];
  return r;
}

/** Index rows by composite key for O(1) to-one lookups (keyed by target PK columns). */
function indexByCompositeKey(rows: unknown[], keys: string[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const r of rows) {
    map.set(makeCompositeKey(r as Record<string, unknown>, keys), r);
  }
  return map;
}

/** Group rows by composite key for O(1) to-many lookups (keyed by FK columns). */
function groupByCompositeKey(rows: unknown[], keys: string[]): Map<string, unknown[]> {
  return groupBy(rows, (r) => makeCompositeKey(r as Record<string, unknown>, keys));
}
