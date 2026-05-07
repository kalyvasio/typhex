/**
 * Relation assembler: attaches relation data onto rows.
 * Handles both flat JOIN columns (assembleJoined) and pre-fetched maps (assembleFetched).
 */

import type { JoinedProjection, RelationFetchMetadata } from "../query-plan/query-plan.js";
import { makeCompositeKey } from "../../query-helpers.js";

export type RelationFetchedData = Map<string, Map<string, unknown> | Map<string, unknown[]>>;

/** Attaches JOIN-projected and separately fetched relation data onto result rows. */
export class RelationAssembler {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  /**
   * Reconstruct nested objects from flat JOIN columns
   * (e.g. author_name to row.author.name) using pre-extracted projections.
   */
  assembleJoined(projections: JoinedProjection[]): void {
    for (const proj of projections) {
      if (proj.members.length === 0) continue;
      for (const row of this.rows) {
        const obj: Record<string, unknown> = {};
        for (const member of proj.members) obj[member.subPath] = row[member.alias];
        row[proj.outputKey] = obj;
        for (const member of proj.members) delete row[member.alias];
      }
    }
  }

  /** Attach fetched relation maps onto rows. */
  assembleFetched(
    fetches: RelationFetchMetadata[],
    fetched: RelationFetchedData,
    skip: Set<string>,
  ): void {
    for (const meta of fetches) {
      if (skip.has(meta.relation.name)) continue;
      const data = fetched.get(meta.relation.name);
      if (!data) continue;
      if (meta.relationType === "one-to-many" || meta.relationType === "many-to-many") {
        this.attachToManyRelation(meta, data as Map<string, unknown[]>);
      } else {
        this.attachToOneRelation(meta, data as Map<string, unknown>);
      }
    }
  }

  private attachToManyRelation(meta: RelationFetchMetadata, data: Map<string, unknown[]>): void {
    const pkCols = meta.parentPkColumns!;
    for (const row of this.rows) {
      const key = makeCompositeKey(row, pkCols);
      row[meta.relation.outputKey] = data.get(key) ?? [];
    }
  }

  private attachToOneRelation(meta: RelationFetchMetadata, data: Map<string, unknown>): void {
    for (const row of this.rows) {
      const key = makeCompositeKey(row, meta.fkColumns);
      row[meta.relation.outputKey] = data.get(key) ?? null;
    }
  }
}
