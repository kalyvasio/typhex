import { getDialect } from "../../../dbs/index.js";
import type { DialectImpl } from "../../../dbs/types.js";
import type { QueryExecutor } from "../../db.js";
import { InsertGraphExecutor } from "./insert-graph-executor.js";
import type { PlannedNode } from "./insert-graph-planner.js";
import { groupBy } from "../../../utils.js";
import { SequenceIdAssigner } from "./sequence-id-assigner.js";

type InsertGroup = {
  tableName: string;
  items: PlannedNode[];
  mode: "single" | "batch";
};

export class InsertGraphBatchExecutor extends InsertGraphExecutor {
  protected async insertReadyNodes(qe: QueryExecutor, nodes: PlannedNode[]): Promise<void> {
    const dialect = getDialect(qe.dialect);
    for (const group of groupByTable(nodes)) {
      await this.insertNodeGroup(dialect, qe, group);
    }
  }

  private async insertNodeGroup(
    dialect: DialectImpl,
    qe: QueryExecutor,
    group: InsertGroup,
  ): Promise<void> {
    await new SequenceIdAssigner(dialect, qe, group.tableName, group.items).assign();
    if (group.mode === "single") {
      await this.insertSingleNode(qe, group.items[0]);
      return;
    }
    await this.insertNodeBatch(qe, group);
  }

  private async insertNodeBatch(qe: QueryExecutor, group: InsertGroup): Promise<void> {
    const entity = group.items[0].entity;
    const inserted = await entity.query(qe).insertMany(group.items.map((node) => node.scalarData));
    if (inserted.length > 0 && inserted.length !== group.items.length) {
      throw new Error("insertGraph: insertMany did not return the expected number of rows");
    }
    for (const [index, node] of group.items.entries()) {
      const insertedRow = inserted[index] as Record<string, unknown> | undefined;
      if (insertedRow) {
        node.insertedRow = insertedRow;
        node.materializedRow = insertedRow;
      } else {
        node.insertedRow = { ...node.scalarData };
      }
    }
  }
}

function groupByTable(nodes: PlannedNode[]): InsertGroup[] {
  return [...groupBy(nodes, (node) => node.tableName)].map(([tableName, items]) => ({
    tableName,
    items,
    mode: items.length === 1 ? "single" : "batch",
  }));
}
