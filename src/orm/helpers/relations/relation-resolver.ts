/**
 * Relation resolver: top-level orchestrator for relation loading.
 */

import type { QueryExecutor } from "../../db.js";
import type { QueryPlan } from "../../query-plan.js";
import { fetchRelations } from "./relation-fetcher.js";
import { assembleJoined, assembleFetched } from "./relation-assembler.js";

/** Execute the full relation-loading pipeline for a set of result rows:
 *  1. Fetch related rows via WHERE IN queries (relation-fetcher).
 *  2. Reconstruct JOIN columns into nested objects on rows that used a JOIN (relation-assembler).
 *  3. Attach the fetched rows onto each parent row (relation-assembler). */
export async function resolveRelations(
  plan: QueryPlan,
  qe: QueryExecutor,
  rows: Record<string, unknown>[],
): Promise<void> {
  const fetched = await fetchRelations(qe, rows, plan.relationFetches, plan.skipLoadFor);
  if (plan.joinedProjections.length > 0) assembleJoined(rows, plan.joinedProjections);
  assembleFetched(rows, plan.relationFetches, fetched, plan.skipLoadFor);
}
