/**
 * Relation resolver: top-level orchestrator for relation loading.
 * Calls relation-fetcher to run WHERE IN queries for each relation, then
 * calls relation-assembler to attach the results (and any JOIN columns)
 * back onto the result rows. The RelationContext produced by
 * relation-context-builder drives every decision made here.
 */

import type { IrSelect } from "../ir/types.js";
import type { Driver } from "../driver/types.js";
import type { RelationContext } from "./relation-context-builder.js";
import { fetchRelations } from "./relation-fetcher.js";
import { assembleJoined, assembleFetched } from "./relation-assembler.js";

/** Execute the full relation-loading pipeline for a set of result rows:
 *  1. Fetch related rows via WHERE IN queries (relation-fetcher).
 *  2. Reconstruct JOIN columns into nested objects on rows that used a JOIN (relation-assembler).
 *  3. Attach the fetched rows onto each parent row (relation-assembler). */
export async function resolveRelations(
  ctx: RelationContext,
  selectIr: IrSelect | null,
  driver: Driver,
  rows: Record<string, unknown>[]
): Promise<void> {
  const fetched = await fetchRelations(driver, rows, ctx.relationFetches, ctx.skipLoadFor);
  if (ctx.hasReusableRelationInSelect) assembleJoined(rows, ctx.reusableJoinKeys, selectIr!);
  assembleFetched(rows, ctx.relationFetches, fetched, ctx.skipLoadFor);
}
