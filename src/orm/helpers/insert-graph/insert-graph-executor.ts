import type { QueryExecutor } from "../../db.js";
import type { InsertGraphPlan, PlannedNode } from "./insert-graph-planner.js";

export abstract class InsertGraphExecutor {
  constructor(protected readonly plan: InsertGraphPlan) {}

  async execute(): Promise<void> {
    await this.drainNodes();
  }

  private async drainNodes(): Promise<void> {
    let ready = this.getReadyNodes();
    while (ready.length > 0) {
      for (const node of ready) this.applyPendingCopies(node);
      await this.insertReadyNodes(this.plan.qe, ready);
      ready = this.getReadyNodes();
    }
    const stuck = this.plan.nodes.filter((node) => node.insertedRow == null);
    if (stuck.length > 0) {
      throw new Error("insertGraph: unresolved node dependencies");
    }
  }

  protected async insertSingleNode(qe: QueryExecutor, node: PlannedNode): Promise<void> {
    const inserted = (await node.entity.query(qe).insert(node.scalarData)) as Record<
      string,
      unknown
    >;
    node.insertedRow = inserted;
    node.materializedRow = inserted;
  }

  private getReadyNodes(): PlannedNode[] {
    return this.plan.nodes
      .filter(
        (node) =>
          node.insertedRow == null &&
          node.dependencyIds.every((id) => this.plan.nodes[id]?.insertedRow != null),
      )
      .sort((left, right) => left.id - right.id);
  }

  private applyPendingCopies(node: PlannedNode): void {
    for (const copy of node.pendingCopies) {
      const sourceRow = this.plan.nodes[copy.sourceNodeId].insertedRow!;
      for (let i = 0; i < copy.targetColumns.length; i++) {
        node.scalarData[copy.targetColumns[i]] = sourceRow[copy.sourceColumns[i]];
      }
    }
  }

  protected abstract insertReadyNodes(qe: QueryExecutor, nodes: PlannedNode[]): Promise<void>;
}
