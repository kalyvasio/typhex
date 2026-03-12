/**
 * Relation loading: fetches related entities via separate queries and attaches to parent rows.
 * Used when select() includes relation properties (e.g. author: p.author).
 */

import type { RelationsMap } from "../entity/relations.js";
import type { IrSelect, IrNode, IrOrderBy } from "../ir/types.js";
import type { Driver } from "../driver/types.js";
import { whereColumnIn, whereAnd } from "./query-helpers.js";

type QueryBuilderLike = {
  where(ir: unknown, params?: Record<string, unknown>): QueryBuilderLike;
  select(cols: string[]): QueryBuilderLike;
  orderBy(col: string, dir: string): QueryBuilderLike;
  limit(n: number): QueryBuilderLike;
  offset(n: number): QueryBuilderLike;
  toArray(): Promise<unknown[]>;
};

export interface RelationLoadSpec {
  name: string;
  outputKey: string;
  subPaths?: string[][];
  whereIr?: IrNode;
  whereParams?: Record<string, unknown>;
  orderBy?: IrOrderBy[];
  limitNum?: number | null;
  offsetNum?: number | null;
  fkColumn: string;
  targetPk: string;
  targetEntity: { query(d?: Driver): QueryBuilderLike };
  isArray: boolean;
}

/** Resolve which paths are columns vs relations. Returns column paths and relation specs. */
export function resolveSelectColumnsAndRelations(
  select: IrSelect | null,
  columnNames: string[],
  relations: RelationsMap,
  pkColumn?: string | null
): { columnPaths: string[][]; columnAliases: string[]; relationSpecs: RelationLoadSpec[] } {
  const columnPaths: string[][] = [];
  const columnAliases: string[] = [];
  const relationSpecs: RelationLoadSpec[] = [];

  if (!select) {
    return { columnPaths: [], columnAliases: [], relationSpecs: [] };
  }

  const relNames = new Set(Object.keys(relations));

  for (let i = 0; i < select.paths.length; i++) {
    const path = select.paths[i];
    const alias = select.aliases?.[i] ?? path[path.length - 1];

    if (path.length === 1 && relNames.has(path[0])) {
      const relDef = relations[path[0]];
      const spec = buildRelationSpec(path[0], alias, {}, relDef);
      if (spec) relationSpecs.push(spec);
    } else if (path.length > 0 && relNames.has(path[0])) {
      const relDef = relations[path[0]];
      const spec = buildRelationSpec(path[0], alias, { subPaths: [path.slice(1)] }, relDef);
      if (spec) relationSpecs.push(spec);
    } else {
      columnPaths.push(path);
      columnAliases.push(alias);
    }
  }

  const seenOutputKeys = new Set(relationSpecs.map((s) => s.outputKey));
  for (const r of select.relations ?? []) {
    const relDef = relations[r.name];
    if (!relDef || seenOutputKeys.has(r.outputKey)) continue;
    seenOutputKeys.add(r.outputKey);
    const spec = buildRelationSpec(r.name, r.outputKey, r, relDef);
    if (spec) relationSpecs.push(spec);
  }

  for (const spec of relationSpecs) {
    if (!spec.isArray) {
      if (!columnPaths.some((p) => p[0] === spec.fkColumn)) {
        columnPaths.push([spec.fkColumn]);
        columnAliases.push(spec.fkColumn);
      }
    } else if (pkColumn && !columnPaths.some((p) => p[0] === pkColumn)) {
      columnPaths.push([pkColumn]);
      columnAliases.push(pkColumn);
    }
  }

  return { columnPaths, columnAliases, relationSpecs };
}

function buildRelationSpec(
  name: string,
  outputKey: string,
  rel: { subPaths?: string[][]; whereIr?: IrNode; whereParams?: Record<string, unknown>; orderBy?: IrOrderBy[]; limitNum?: number | null; offsetNum?: number | null },
  relDef: { _relType: string; _target: () => unknown; _options: { foreignKey?: string; references?: string; junction?: string; referenceKey?: string } }
): RelationLoadSpec | null {
  const opts = relDef._options as { foreignKey?: string; references?: string; junction?: string; referenceKey?: string };
  const target = relDef._target();
  const targetEntity = target && typeof (target as any).query === "function" ? (target as any) : null;
  if (!targetEntity) return null;

  const isArray = relDef._relType === "one-to-many" || relDef._relType === "many-to-many";
  const base = { name, outputKey, subPaths: rel.subPaths, whereIr: rel.whereIr, whereParams: rel.whereParams, orderBy: rel.orderBy, limitNum: rel.limitNum, offsetNum: rel.offsetNum };

  if (relDef._relType === "many-to-one" || relDef._relType === "one-to-one") {
    const fkColumn = opts.foreignKey!;
    const targetPk = opts.references ?? "id";
    return { ...base, fkColumn, targetPk, targetEntity, isArray: false };
  }

  if (relDef._relType === "one-to-many") {
    const fkColumn = opts.foreignKey!;
    const targetPk = "id";
    return { ...base, fkColumn, targetPk, targetEntity, isArray: true };
  }

  if (relDef._relType === "many-to-many") {
    return null;
  }

  return null;
}

/** Load relations and attach to rows. Mutates rows in place. */
export async function loadRelations(
  rows: Record<string, unknown>[],
  specs: RelationLoadSpec[],
  driver: Driver
): Promise<void> {
  for (const spec of specs) {
    if (spec.isArray) {
      await loadOneToMany(rows, spec, driver);
    } else {
      await loadManyToOne(rows, spec, driver);
    }
  }
}

async function loadManyToOne(
  rows: Record<string, unknown>[],
  spec: RelationLoadSpec,
  driver: Driver
): Promise<void> {
  const fkValues = [...new Set(rows.map((r) => r[spec.fkColumn]).filter((v) => v != null))];
  if (fkValues.length === 0) {
    for (const row of rows) row[spec.outputKey] = null;
    return;
  }

  const ids = fkValues as number[];
  const qb = spec.targetEntity.query(driver);
  const baseWhere = whereColumnIn(spec.targetPk, ids);
  const whereIr = spec.whereIr ? whereAnd(baseWhere, spec.whereIr) : baseWhere;
  let chain = qb.where(whereIr, spec.whereParams ?? {});
  for (const o of spec.orderBy ?? []) chain = chain.orderBy(o.path[0] ?? "", o.direction);
  if (spec.limitNum != null) chain = chain.limit(spec.limitNum);
  if (spec.offsetNum != null) chain = chain.offset(spec.offsetNum);
  if (spec.subPaths && spec.subPaths.length > 0) {
    const cols = spec.subPaths.map((p) => p[0] ?? p).flat();
    if (!cols.includes(spec.targetPk)) cols.push(spec.targetPk);
    chain = chain.select(cols);
  }
  const related = await chain.toArray();

  const map = new Map<unknown, unknown>();
  for (const r of related) {
    const pkVal = (r as Record<string, unknown>)[spec.targetPk];
    if (pkVal !== undefined) map.set(pkVal, r);
  }

  for (const row of rows) {
    const fk = row[spec.fkColumn];
    row[spec.outputKey] = fk != null ? map.get(fk) ?? null : null;
  }
}

async function loadOneToMany(
  rows: Record<string, unknown>[],
  spec: RelationLoadSpec,
  driver: Driver
): Promise<void> {
  const pkCol = "id";
  const pkValues = [...new Set(rows.map((r) => r[pkCol] ?? r[spec.fkColumn]).filter((v) => v != null))];
  if (pkValues.length === 0) {
    for (const row of rows) row[spec.outputKey] = [];
    return;
  }

  const ids = pkValues as number[];
  const qb = spec.targetEntity.query(driver);
  const baseWhere = whereColumnIn(spec.fkColumn, ids);
  const whereIr = spec.whereIr ? whereAnd(baseWhere, spec.whereIr) : baseWhere;
  let chain = qb.where(whereIr, spec.whereParams ?? {});
  for (const o of spec.orderBy ?? []) chain = chain.orderBy(o.path[0] ?? "", o.direction);
  if (spec.limitNum != null) chain = chain.limit(spec.limitNum);
  if (spec.offsetNum != null) chain = chain.offset(spec.offsetNum);
  if (spec.subPaths && spec.subPaths.length > 0) {
    const cols = spec.subPaths.map((p) => p[0] ?? p).flat();
    if (!cols.includes(spec.fkColumn)) cols.push(spec.fkColumn);
    chain = chain.select(cols);
  }
  const related = await chain.toArray();

  const grouped = new Map<unknown, unknown[]>();
  for (const r of related) {
    const fk = (r as Record<string, unknown>)[spec.fkColumn];
    if (fk !== undefined) {
      const arr = grouped.get(fk) ?? [];
      arr.push(r);
      grouped.set(fk, arr);
    }
  }

  for (const row of rows) {
    const pk = row[pkCol] ?? row[spec.fkColumn];
    row[spec.outputKey] = pk != null ? grouped.get(pk) ?? [] : [];
  }
}
