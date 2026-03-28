/**
 * Relation context builder: resolves select paths into column paths and relation fetches,
 * and computes the full RelationContext consumed by RelationRunner and QueryBuilder.
 */

import type { RelationsMap, RelationDef, RelationOptions } from "../entity/relations.js";
import type { IrSelect, IrNode, IrSelectRelation } from "../ir/types.js";
import type { QueryExecutor } from "./db.js";
import type { AnyEntityClass } from "../entity/entity.js";
import {QueryBuilderInterface} from "./query-builder.js";
import { getReusableJoinKeys } from "./relation-joins.js";

export interface RelationFetchMetadata {
  relation: IrSelectRelation;
  fkColumn: string;
  targetPk: string;
  targetEntity: { query(d?: QueryExecutor): QueryBuilderInterface<AnyEntityClass, unknown> };
  isArray: boolean;
}

// ─── relation context ─────────────────────────────────────────────────────────

export type RelationContext = {
  columnPaths: string[][] | null;   // null = no relation transformation; use selectIr as-is
  columnAliases: string[] | null;
  relationFetches: RelationFetchMetadata[];
  reusableJoinKeys: Set<string>;
  hasReusableRelationInSelect: boolean;
  skipLoadFor: Set<string>;
};

/** Builds the full relation-loading context from a query's select/where IR and relation map.
 *  rootParam is the row parameter name derived from the IR (e.g. "u"), passed in by the caller. */
export function buildRelationContext(
    selectIr: IrSelect | null,
    relations: RelationsMap | undefined,
    whereIr: IrNode | null,
    pkColumn: string | null | undefined,
    rootParam: string
): RelationContext {
  const reusableJoinKeys = (relations && selectIr)
      ? getReusableJoinKeys(whereIr, selectIr, relations, rootParam)
      : new Set<string>();
  const hasRelations = !!(relations && selectIr &&
      (selectIr.relations?.length || selectIr.paths.some((p) => p.length >= 1 && relations[p[0]])));

  let columnPaths: string[][] | null = null;
  let columnAliases: string[] | null = null;
  let relationFetches: RelationFetchMetadata[] = [];

  if (hasRelations) {
    const { columnPaths: paths, columnAliases: aliases, relationFetches: fetches } = resolveSelectColumnsAndRelations(
        selectIr!, relations!, pkColumn,
        reusableJoinKeys.size > 0 ? reusableJoinKeys : undefined
    );
    relationFetches = fetches;
    columnPaths = paths;
    columnAliases = aliases;
  }

  const hasReusableRelationInSelect = reusableJoinKeys.size > 0 && !!(selectIr && (
      selectIr.paths.some((p) => p.length > 1 && reusableJoinKeys.has(p[0])) ||
      (selectIr.relations ?? []).some((r) => reusableJoinKeys.has(r.name) && (r.subPaths?.length ?? 0) > 0)
  ));

  const skipLoadFor = computeSkipSet(selectIr, reusableJoinKeys, hasReusableRelationInSelect);

  return { columnPaths, columnAliases, relationFetches, reusableJoinKeys, hasReusableRelationInSelect, skipLoadFor };
}

/** Top-level entry point. Walks all paths and relation entries in the IrSelect,
 *  splitting them into plain column paths (to include in the SQL SELECT list)
 *  and relation fetches (to execute as separate WHERE-IN queries after the main query).
 *  Also appends any FK/PK columns that are needed for correlation but not yet selected. */
function resolveSelectColumnsAndRelations(
  select: IrSelect | null,
  relations: RelationsMap,
  pkColumn?: string | null,
  /** Relation keys already joined in the main query — include their paths in columnPaths, exclude from relationFetches. */
  joinedRelationKeys?: Set<string>
): { columnPaths: string[][]; columnAliases: string[]; relationFetches: RelationFetchMetadata[] } {
  if (!select) return { columnPaths: [], columnAliases: [], relationFetches: [] };

  const relNames = new Set(Object.keys(relations));
  const fromPaths = classifyPathEntries(select, relNames, joinedRelationKeys, relations);
  const seenOutputKeys = new Set(fromPaths.relationFetches.map((m) => m.relation.outputKey));
  const fromRelations = classifyRelationEntries(select, relations, joinedRelationKeys, seenOutputKeys);

  const columnPaths = [...fromPaths.columnPaths, ...fromRelations.columnPaths];
  const columnAliases = [...fromPaths.columnAliases, ...fromRelations.columnAliases];
  const relationFetches = [...fromPaths.relationFetches, ...fromRelations.relationFetches];

  const { paths: keyPaths, aliases: keyAliases } = missingJoinKeyColumns(relationFetches, columnPaths, pkColumn);
  columnPaths.push(...keyPaths);
  columnAliases.push(...keyAliases);

  return { columnPaths, columnAliases, relationFetches };
}

// ─── path predicates ──────────────────────────────────────────────────────────

/** True when the path is a bare relation name, e.g. ["company"] — shorthand for "fetch the whole relation". */
function isWholeRelationPath(path: string[], relNames: Set<string>): boolean {
  return path.length === 1 && relNames.has(path[0]);
}

/** True when the path drills into a relation field, e.g. ["company", "name"]. */
function isRelationFieldPath(path: string[], relNames: Set<string>): boolean {
  return path.length > 1 && relNames.has(path[0]);
}

/** True when the relation's data is already available via a JOIN in the main query. */
function isJoinedRelation(name: string, joinedRelationKeys: Set<string> | undefined): boolean {
  return !!joinedRelationKeys?.has(name);
}

// ─── path-entry branch actions ───

/** Builds a fetch for an entire relation with no subfield restriction, e.g. select u => u.company. */
function wholeRelationFetch(name: string, outputKey: string, relations: RelationsMap): RelationFetchMetadata | null {
  return buildRelationFetchMeta({ name, outputKey }, relations[name]);
}

/** Computes the flat SQL column alias for a joined relation field, e.g. ["company","name"] → "company_name". */
function joinedRelationColumnAlias(path: string[], explicitAlias?: string): string {
  return explicitAlias ?? `${path[0]}_${path[path.length - 1]}`;
}

/** Builds a fetch for a single field on a relation, e.g. ["company","name"] → fetch company, select only "name". */
function relationFieldFetch(name: string, outputKey: string, subPath: string[], relations: RelationsMap): RelationFetchMetadata | null {
  return buildRelationFetchMeta({ name, outputKey, subPaths: [subPath] }, relations[name]);
}

// ─── classifiers ───

/** Classifies each entry in select.paths as either a plain column, a joined relation column,
 *  or a relation to fetch separately. Dotted paths whose root is a joined relation are kept
 *  as flat columns; otherwise a RelationFetchMetadata is created. */
function classifyPathEntries(
  select: IrSelect,
  relNames: Set<string>,
  joinedRelationKeys: Set<string> | undefined,
  relations: RelationsMap
) {
  const columnPaths: string[][] = [];
  const columnAliases: string[] = [];
  const relationFetches: RelationFetchMetadata[] = [];

  for (let i = 0; i < select.paths.length; i++) {
    const path = select.paths[i];
    const alias = select.aliases?.[i] ?? path[path.length - 1];

    if (isWholeRelationPath(path, relNames)) {
      const meta = wholeRelationFetch(path[0], alias, relations);
      if (meta) relationFetches.push(meta);
    } else if (isRelationFieldPath(path, relNames)) {
      if (isJoinedRelation(path[0], joinedRelationKeys)) {
        columnPaths.push(path);
        columnAliases.push(joinedRelationColumnAlias(path, select.aliases?.[i]));
      } else {
        const meta = relationFieldFetch(path[0], alias, path.slice(1), relations);
        if (meta) relationFetches.push(meta);
      }
    } else {
      columnPaths.push(path);
      columnAliases.push(alias);
    }
  }

  return { columnPaths, columnAliases, relationFetches };
}

// ─── joined-relation column expansion ───

/** Expands a joined relation's subPaths into flat SQL column paths,
 *  e.g. { name:"company", subPaths:[["id"],["name"]] } → ["company","id"], ["company","name"]
 *  with aliases "company_id", "company_name". */
function expandJoinedRelationToColumns(r: IrSelectRelation): { paths: string[][]; aliases: string[] } {
  const paths: string[][] = [];
  const aliases: string[] = [];
  for (const sub of r.subPaths ?? []) {
    if (sub.length > 0) {
      paths.push([r.name, ...sub]);
      aliases.push(`${r.outputKey}_${sub.join("_")}`);
    }
  }
  return { paths, aliases };
}

/** Classifies each explicit relation entry in select.relations. Joined relations with subPaths
 *  are expanded into flat column paths; all others become separate relation fetches. */
function classifyRelationEntries(
  select: IrSelect,
  relations: RelationsMap,
  joinedRelationKeys: Set<string> | undefined,
  seenOutputKeys: Set<string>
) {
  const columnPaths: string[][] = [];
  const columnAliases: string[] = [];
  const relationFetches: RelationFetchMetadata[] = [];

  for (const r of select.relations ?? []) {
    const relDef = relations[r.name];
    if (!relDef || seenOutputKeys.has(r.outputKey)) continue;
    seenOutputKeys.add(r.outputKey);

    if (isJoinedRelation(r.name, joinedRelationKeys) && r.subPaths?.length) {
      const { paths, aliases } = expandJoinedRelationToColumns(r);
      columnPaths.push(...paths);
      columnAliases.push(...aliases);
    } else {
      const meta = buildRelationFetchMeta(r, relDef);
      if (meta) relationFetches.push(meta);
    }
  }

  return { columnPaths, columnAliases, relationFetches };
}

// ─── required join-key helpers ────────────────────────────────────────────────

/** Returns the FK column name if it is not already in the selected paths, otherwise null.
 *  Needed for to-one relations so the main row can look up its related entity. */
function missingToOneFkColumn(fkColumn: string, existingPaths: string[][]): string | null {
  return existingPaths.some((p) => p[0] === fkColumn) ? null : fkColumn;
}

/** Returns the PK column name if it is not already in the selected paths, otherwise null.
 *  Needed for to-many relations so child rows can be grouped back onto the correct parent. */
function missingToManyPkColumn(pkColumn: string | null | undefined, existingPaths: string[][]): string | null {
  if (!pkColumn) return null;
  return existingPaths.some((p) => p[0] === pkColumn) ? null : pkColumn;
}

/** Finds any FK or PK columns required to correlate fetched relations back to their parent rows
 *  that are not already present in the SQL SELECT list, and returns them to be appended. */
function missingJoinKeyColumns(
  fetches: RelationFetchMetadata[],
  existingPaths: string[][],
  pkColumn?: string | null
): { paths: string[][]; aliases: string[] } {
  const paths: string[][] = [];
  const aliases: string[] = [];

  for (const meta of fetches) {
    const missing = meta.isArray
      ? missingToManyPkColumn(pkColumn, existingPaths)
      : missingToOneFkColumn(meta.fkColumn, existingPaths);
    if (missing) {
      paths.push([missing]);
      aliases.push(missing);
    }
  }

  return { paths, aliases };
}

/** Returns the set of relation names that should be skipped during fetch because their
 *  data is already available from a JOIN in the main query. */
function computeSkipSet(
  selectIr: IrSelect | null,
  reusableJoinKeys: Set<string>,
  hasReusableRelationInSelect: boolean
): Set<string> {
  const skip = new Set<string>();
  if (!hasReusableRelationInSelect || !selectIr) return skip;
  for (const p of selectIr.paths)
    if (p.length > 1 && reusableJoinKeys.has(p[0])) skip.add(p[0]);
  for (const r of selectIr.relations ?? [])
    if (reusableJoinKeys.has(r.name) && r.subPaths?.length) skip.add(r.name);
  return skip;
}

/** Builds a RelationFetchMetadata from an IrSelectRelation and its RelationDef.
 *  Resolves the target entity, foreign key, and cardinality (isArray) from the relation definition.
 *  Returns null if the target entity cannot be resolved or the relation type is unsupported. */
function buildRelationFetchMeta(
  ir: IrSelectRelation,
  relDef: RelationDef
): RelationFetchMetadata | null {
  const target = relDef._target();
  const targetEntity = target && typeof (target as any).query === "function" ? (target as any) : null;
  if (!targetEntity) return null;

  const fkColumn = (relDef._options as RelationOptions).foreignKey!;

  switch (relDef._relType) {
    case "many-to-one":
    case "one-to-one":
      return { relation: ir, fkColumn, targetPk: (relDef._options as RelationOptions).references ?? "id", targetEntity, isArray: false };
    case "one-to-many":
      return { relation: ir, fkColumn, targetPk: "id", targetEntity, isArray: true };
    default:
      return null;
  }
}
