/**
 * Relation resolver: top-level orchestrator for relation loading.
 */

import type { IrSelect } from "../../../ir/types.js";
import type { QueryExecutor } from "../../db.js";
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
  qe: QueryExecutor,
  rows: Record<string, unknown>[]
): Promise<void> {
  const fetched = await fetchRelations(qe, rows, ctx.relationFetches, ctx.skipLoadFor);
  if (ctx.hasReusableRelationInSelect) assembleJoined(rows, ctx.reusableJoinKeys, selectIr!);
  assembleFetched(rows, ctx.relationFetches, fetched, ctx.skipLoadFor);
}
