import type { QueryExecutor } from "../../db.js";
import { InsertGraphExecutor } from "./insert-graph-executor.js";
import type { PlannedNode } from "./insert-graph-planner.js";

export class InsertGraphSequentialExecutor extends InsertGraphExecutor {
  protected async insertReadyNodes(qe: QueryExecutor, nodes: PlannedNode[]): Promise<void> {
    for (const node of nodes) await this.insertSingleNode(qe, node);
  }
}
