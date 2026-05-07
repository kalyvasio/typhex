/**
 * Relation resolver: top-level orchestrator for relation loading.
 */

import type { QueryExecutor } from "../../db.js";
import type { QueryPlan } from "../query-plan/query-plan.js";
import { RelationFetcher } from "./relation-fetcher.js";
import { RelationAssembler } from "./relation-assembler.js";

/** Executes the full relation-loading pipeline for a set of result rows. */
export class RelationResolver {
  constructor(
    private readonly plan: QueryPlan,
    private readonly qe: QueryExecutor,
    private readonly rows: Record<string, unknown>[],
  ) {}

  async resolve(): Promise<void> {
    const fetched = await new RelationFetcher(
      this.qe,
      this.rows,
      this.plan.relationFetches,
      this.plan.skipLoadFor,
    ).fetch();
    const assembler = new RelationAssembler(this.rows);
    if (this.plan.joinedProjections.length > 0) {
      assembler.assembleJoined(this.plan.joinedProjections);
    }
    assembler.assembleFetched(this.plan.relationFetches, fetched, this.plan.skipLoadFor);
  }
}
