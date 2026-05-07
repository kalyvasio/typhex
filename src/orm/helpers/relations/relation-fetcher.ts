/**
 * Relation fetcher: fetches related entities via WHERE IN queries.
 * Does NOT mutate rows — returns fetched data as maps.
 */

import type { QueryExecutor } from "../../db.js";
import type { RelationFetchMetadata } from "../query-plan/query-plan.js";
import type { IrSelectRelation } from "../../../ir/types.js";
import { whereAnd, makeCompositeKey, buildRelationFetchWhereIr } from "../../query-helpers.js";
import { getEntityByTableName } from "../../../entity/global-driver.js";
import type { AnyEntityClass } from "../../../entity/entity.js";
import { groupBy } from "../../../utils.js";

export type RelationFetchResult = Map<string, Map<string, unknown> | Map<string, unknown[]>>;

/** Runs one WHERE IN query per pending relation fetch and collects keyed result maps. */
export class RelationFetcher {
  constructor(
    private readonly qe: QueryExecutor,
    private readonly rows: Record<string, unknown>[],
    private readonly fetches: RelationFetchMetadata[],
    private readonly skip: Set<string>,
  ) {}

  async fetch(): Promise<RelationFetchResult> {
    const result: RelationFetchResult = new Map();
    for (const meta of this.fetches) {
      if (this.skip.has(meta.relation.name)) continue;
      result.set(meta.relation.name, await this.fetchRelation(meta));
    }
    return result;
  }

  private fetchRelation(
    meta: RelationFetchMetadata,
  ): Promise<Map<string, unknown> | Map<string, unknown[]>> {
    switch (meta.relationType) {
      case "many-to-many":
        return this.fetchManyToMany(meta);
      case "one-to-many":
        return this.fetchOneToMany(meta);
      default:
        return this.fetchOneToOne(meta);
    }
  }

  /** Fetch a to-many relation: WHERE IN on FK columns, grouped by FK composite key. */
  private async fetchOneToMany(meta: RelationFetchMetadata): Promise<Map<string, unknown[]>> {
    const parentPkCols = meta.parentPkColumns!;
    const related = await this.fetchRows(
      this.rows,
      parentPkCols,
      meta.fkColumns,
      meta.targetEntity,
      meta.relation,
    );
    return this.groupByCompositeKey(related, meta.fkColumns);
  }

  /** Fetch a to-one relation: WHERE IN on FK to target-PK, indexed by target PK composite key. */
  private async fetchOneToOne(meta: RelationFetchMetadata): Promise<Map<string, unknown>> {
    const related = await this.fetchRows(
      this.rows,
      meta.fkColumns,
      meta.targetPkColumns,
      meta.targetEntity,
      meta.relation,
    );
    return this.indexByCompositeKey(related, meta.targetPkColumns);
  }

  /** Many-to-many: two fetchRows calls through the junction, grouped by parent composite key. */
  private async fetchManyToMany(meta: RelationFetchMetadata): Promise<Map<string, unknown[]>> {
    const j = meta.junction!;
    const parentPkCols = meta.parentPkColumns!;

    const out = new Map<string, unknown[]>();
    for (const row of this.rows) out.set(makeCompositeKey(row, parentPkCols), []);

    const junctionEntity = getEntityByTableName(j.table) as AnyEntityClass;
    const junctionRows = (await this.fetchRows(
      this.rows,
      parentPkCols,
      j.foreignKey,
      junctionEntity,
    )) as Record<string, unknown>[];
    if (junctionRows.length === 0) return out;

    const related = await this.fetchRows(
      junctionRows,
      j.referenceKey,
      meta.targetPkColumns,
      meta.targetEntity,
      meta.relation,
    );
    const targetToParents = this.buildTargetParentIndex(junctionRows, meta);

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

  private buildTargetParentIndex(
    junctionRows: Record<string, unknown>[],
    meta: RelationFetchMetadata,
  ): Map<string, string[]> {
    const j = meta.junction!;
    const parentPkCols = meta.parentPkColumns!;
    const targetToParents = new Map<string, string[]>();

    for (const jr of junctionRows) {
      const parentKey = makeCompositeKey(
        this.remapCols(jr, j.foreignKey, parentPkCols),
        parentPkCols,
      );
      const targetKey = makeCompositeKey(
        this.remapCols(jr, j.referenceKey, meta.targetPkColumns),
        meta.targetPkColumns,
      );
      const arr = targetToParents.get(targetKey) ?? [];
      arr.push(parentKey);
      targetToParents.set(targetKey, arr);
    }

    return targetToParents;
  }

  /** Batch-fetch rows from `entity` by mapping source column values onto target columns. */
  private async fetchRows(
    srcRows: Record<string, unknown>[],
    srcCols: string[],
    tgtCols: string[],
    entity: AnyEntityClass,
    rel?: IrSelectRelation,
  ): Promise<unknown[]> {
    const baseWhere = buildRelationFetchWhereIr(srcRows, srcCols, tgtCols);
    if (!baseWhere) return [];

    const whereIr = rel?.whereIr ? whereAnd(baseWhere, rel.whereIr) : baseWhere;
    let chain = entity.query(this.qe).where(whereIr, rel?.whereParams ?? {});
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

  private remapCols(
    row: Record<string, unknown>,
    from: string[],
    to: string[],
  ): Record<string, unknown> {
    const r: Record<string, unknown> = {};
    for (let i = 0; i < to.length; i++) r[to[i]] = row[from[i] ?? from[0]];
    return r;
  }

  private indexByCompositeKey(rows: unknown[], keys: string[]): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const row of rows) {
      map.set(makeCompositeKey(row as Record<string, unknown>, keys), row);
    }
    return map;
  }

  private groupByCompositeKey(rows: unknown[], keys: string[]): Map<string, unknown[]> {
    return groupBy(rows, (row) => makeCompositeKey(row as Record<string, unknown>, keys));
  }
}
