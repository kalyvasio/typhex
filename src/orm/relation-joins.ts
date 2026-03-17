/**
 * Relation join resolution: extract relations from where IR and build JOIN metadata.
 * When a relation is referenced in where (e.g. p.author.name === "Alice"), emit a JOIN
 * instead of failing on non-existent column.
 */

import type { IrNode, IrMember, IrSelect, IrOrderBy, JoinHint, JoinType } from "../ir/types.js";
import type { RelationsMap, RelationDef } from "../entity/relations.js";

export interface RelationJoinInfo {
  relationKey: string;
  alias: string;
  targetTable: string;
  targetPk: string;
  foreignKey: string;
  relType: "many-to-one" | "one-to-one";
  joinType: JoinType;
}

export interface OneToManyExistsInfo {
  targetTable: string;
  fkColumn: string;
  mainPk: string;
  alias: string;
}

/**
 * Build EXISTS metadata for one-to-many relations in the where clause.
 * One-to-many uses EXISTS subquery instead of JOIN to avoid row duplication.
 */
export function buildOneToManyExists(
  whereNode: IrNode | null,
  relations: RelationsMap,
  rootParam: string,
  mainPk: string,
  resolveTarget: (rel: RelationDef) => { table: string; pk: string } | null,
  aliasPrefix = "ex"
): Record<string, OneToManyExistsInfo> {
  const keys = new Set<string>();
  collectRelationKeysFromNode(whereNode, relations, rootParam, keys);
  const result: Record<string, OneToManyExistsInfo> = {};
  let idx = 0;
  for (const relKey of keys) {
    const rel = relations[relKey] as RelationDef | undefined;
    if (!rel || rel._relType !== "one-to-many") continue;
    const opts = rel._options;
    if ("junction" in opts) continue;
    const target = resolveTarget(rel);
    if (!target) continue;
    const fk = "foreignKey" in opts ? opts.foreignKey : "";
    if (!fk) continue;
    result[`${rootParam}.${relKey}`] = {
      targetTable: target.table,
      fkColumn: fk,
      mainPk,
      alias: `${aliasPrefix}${idx++}`,
    };
  }
  return result;
}

export interface RelationJoinContext {
  relations: RelationsMap;
  tableName: string;
  columnNames: string[];
  pkColumn: string;
  resolveTarget: (rel: RelationDef) => { table: string; pk: string } | null;
}

/** Walk an IR node tree and collect every relation key referenced via member access
 *  on the root parameter (e.g. `c.company.name` → adds "company" to `out`). */
function collectRelationKeysFromNode(
  node: IrNode | null,
  relations: RelationsMap,
  rootParam: string,
  out: Set<string>
): void {
  if (!node) return;
  if (node.kind === "member") {
    const m = node as IrMember;
    if (m.param === rootParam && m.path.length >= 1 && relations[m.path[0]]) {
      out.add(m.path[0]);
    }
  }
  if (node.kind === "binary") {
    collectRelationKeysFromNode(node.left, relations, rootParam, out);
    collectRelationKeysFromNode(node.right, relations, rootParam, out);
  }
  if (node.kind === "unary") {
    collectRelationKeysFromNode(node.operand, relations, rootParam, out);
  }
  if (node.kind === "in") {
    collectRelationKeysFromNode(node.left, relations, rootParam, out);
    collectRelationKeysFromNode(node.right, relations, rootParam, out);
  }
  if (node.kind === "call") {
    collectRelationKeysFromNode(node.receiver, relations, rootParam, out);
    for (const a of node.args) collectRelationKeysFromNode(a, relations, rootParam, out);
  }
  if (node.kind === "exists") {
    if (node.rootParam === rootParam) out.add(node.relationKey);
  }
}

/** Collect relation keys referenced in a select IR — from dotted paths (e.g. ["company","name"])
 *  and from explicit relation entries in `select.relations`. */
function collectRelationKeysFromSelect(
  select: IrSelect | null,
  relations: RelationsMap,
  rootParam: string
): Set<string> {
  const out = new Set<string>();
  if (!select) return out;
  for (const path of select.paths) {
    if (path.length >= 1 && relations[path[0]]) {
      out.add(path[0]);
    }
  }
  for (const r of select.relations ?? []) {
    if (relations[r.name]) out.add(r.name);
  }
  return out;
}

/**
 * Relation keys that can reuse joined data for select (no whereIn needed).
 * A relation is reusable when it's in both where and select. Where joins the whole
 * relation table; there is no projection in where, so no projection comparison.
 */
export function getReusableJoinKeys(
  whereNode: IrNode | null,
  selectNode: IrSelect | null,
  relations: RelationsMap,
  rootParam: string
): Set<string> {
  const whereKeys = new Set<string>();
  collectRelationKeysFromNode(whereNode ?? { kind: "const", value: null }, relations, rootParam, whereKeys);
  const selectKeys = collectRelationKeysFromSelect(selectNode, relations, rootParam);
  const reusable = new Set<string>();
  for (const k of whereKeys) {
    if (!selectKeys.has(k)) continue;
    const rel = relations[k] as RelationDef | undefined;
    if (rel?._relType === "one-to-many") continue;
    reusable.add(k);
  }
  return reusable;
}

function collectRelationKeysFromOrderBy(
  orderBy: IrOrderBy[],
  relations: RelationsMap,
  _rootParam: string,
  out: Set<string>
): void {
  for (const order of orderBy) {
    if (order.path.length > 1) {
      const key = order.path[0];
      if (key in relations) out.add(key);
    }
  }
}

function collectJoinableRelationKeys(
  whereNode: IrNode | null,
  relations: RelationsMap,
  rootParam: string,
  orderBy?: IrOrderBy[],
  joinHints?: JoinHint[]
): Set<string> {
  const keys = new Set<string>();
  collectRelationKeysFromNode(whereNode, relations, rootParam, keys);
  if (orderBy?.length) collectRelationKeysFromOrderBy(orderBy, relations, rootParam, keys);
  if (joinHints) {
    for (const hint of joinHints) {
      if (hint.relationKey in relations) keys.add(hint.relationKey);
    }
  }
  return keys;
}

/**
 * Build JOIN metadata for relations used in the where clause or orderBy.
 * Relations used only in select are loaded via whereIn (separate query).
 * Relations in both where and select reuse the join when select projection <= where projection.
 */
export function buildRelationJoins(
  ctx: RelationJoinContext,
  whereNode: IrNode | null,
  selectNode: IrSelect | null,
  rootParam: string,
  orderBy?: IrOrderBy[],
  joinHints?: JoinHint[]
): RelationJoinInfo[] {
  const { relations } = ctx;
  const keys = collectJoinableRelationKeys(whereNode, relations, rootParam, orderBy, joinHints);

  const result: RelationJoinInfo[] = [];
  let aliasIndex = 1;

  for (const relKey of keys) {
    const rel = relations[relKey] as RelationDef | undefined;
    if (!rel) continue;

    const opts = rel._options;
    if ("junction" in opts) continue;

    const relType = rel._relType;
    if (relType !== "many-to-one" && relType !== "one-to-one") continue;

    const target = ctx.resolveTarget(rel);
    if (!target) continue;

    const fk = "foreignKey" in opts ? opts.foreignKey : "";
    if (!fk) continue;

    const hint = joinHints?.slice().reverse().find(h => h.relationKey === relKey);
    const joinType: JoinType = hint?.joinType ?? "left";
    result.push({
      relationKey: relKey,
      alias: `t${aliasIndex++}`,
      targetTable: target.table,
      targetPk: target.pk,
      foreignKey: fk,
      relType,
      joinType,
    });
  }

  return result;
}

/** Build a lookup from `${param}.${relationKey}` to the JOIN alias
 *  (e.g. `"c.company" → "t1"`), used when the dialect compiles column
 *  references in WHERE and SELECT clauses. */
export function buildRelationPathToAlias(
  joins: RelationJoinInfo[],
  params: string[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const j of joins) {
    for (const param of params) {
      map[`${param}.${j.relationKey}`] = j.alias;
    }
  }
  return map;
}
