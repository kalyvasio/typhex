import type { DialectImpl } from "../../../dbs/types.js";
import type { QueryExecutor } from "../../db.js";
import type { PlannedNode } from "./insert-graph-planner.js";

export class SequenceIdAssigner {
  constructor(
    private readonly dialect: DialectImpl,
    private readonly qe: QueryExecutor,
    private readonly tableName: string,
    private readonly nodes: PlannedNode[],
  ) {}

  async assign(): Promise<void> {
    const sequenceNodes = this.nodes.filter((node) => node.idResolution === "needsSequence");
    if (sequenceNodes.length === 0) return;

    const pkColumn = this.requireSinglePkColumn(sequenceNodes[0].pkColumns);
    const values = await this.allocateValues(pkColumn, sequenceNodes.length);
    for (const [index, node] of sequenceNodes.entries()) {
      node.scalarData[pkColumn] = values[index];
      node.idResolution = "provided";
    }
  }

  private requireSinglePkColumn(pkColumns: string[]): string {
    if (pkColumns.length !== 1) {
      throw new Error("insertGraph: sequence-backed batch inserts require a single primary key column");
    }
    return pkColumns[0];
  }

  private async allocateValues(pkColumn: string, count: number): Promise<unknown[]> {
    const compiled = this.dialect.compileNextSequenceValues(this.tableName, pkColumn, count);
    const rows = await this.qe.query(compiled.sql, compiled.params);
    return this.extractValues(rows, count);
  }

  private extractValues(rows: unknown[], expectedCount: number): unknown[] {
    if (rows.length !== expectedCount) {
      throw new Error("insertGraph: sequence allocation did not return the expected number of rows");
    }
    return rows.map((row) => {
      if (row != null && typeof row === "object") {
        const values = Object.values(row as Record<string, unknown>);
        if (values.length === 1) return values[0];
      }
      throw new Error("insertGraph: sequence allocation rows must contain exactly one value");
    });
  }
}
