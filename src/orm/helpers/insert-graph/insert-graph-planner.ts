import type { Dialect, DialectInsertCapabilities } from "../../../dbs/types.js";
import {
  getPkColumnsFromSchema,
  type AnyEntityClass,
  type EntityInstance,
} from "../../../entity/entity.js";
import { getEntityByTableName } from "../../../entity/global-driver.js";
import type {
  JunctionOptions,
  RelationDef,
  RelationOptions,
  RelationsMap,
  RelationType,
} from "../../../entity/relations.js";
import { isRecord, toArray } from "../../../utils.js";
import type { QueryExecutor } from "../../db.js";
import { type QueryState } from "../../query-state.js";
import { InsertGraphBatchExecutor } from "./insert-graph-batch-executor.js";
import { InsertGraphExecutor } from "./insert-graph-executor.js";
import { InsertGraphSequentialExecutor } from "./insert-graph-sequential-executor.js";

type InsertGraphInput = Record<string, unknown> | Record<string, unknown>[];

type GraphInsertIdResolution =
  | "provided"
  | "needsReturning"
  | "needsSequence"
  | "unresolvableInBatch";

type ColumnCopyInstruction = {
  sourceNodeId: number;
  sourceColumns: string[];
  targetColumns: string[];
};

export type PlannedNodeInput = {
  tableName: string;
  entity: AnyEntityClass;
  scalarData: Record<string, unknown>;
  pkColumns: string[];
  idResolution: GraphInsertIdResolution;
  insertedRow?: Record<string, unknown>;
  materializedRow?: Record<string, unknown>;
};

export type PlannedNode = PlannedNodeInput & {
  id: number;
  dependencyIds: number[];
  pendingCopies: ColumnCopyInstruction[];
};

export type InsertGraphPlan = {
  qe: QueryExecutor;
  nodes: PlannedNode[];
  rootNodeIds: number[];
};

type InsertEntityInfo = {
  tableName: string;
  columnSet: Set<string>;
  rels: RelationsMap | undefined;
  pkColumns: string[];
  entity: AnyEntityClass;
};

export class InsertGraphPlanner<C extends AnyEntityClass> {
  constructor(
    private readonly state: QueryState<EntityInstance<C>>,
    private readonly input: InsertGraphInput,
  ) {}

  async execute(): Promise<EntityInstance<C> | EntityInstance<C>[]> {
    const graphs = toArray(this.input);
    if (graphs.length === 0) return [] as EntityInstance<C>[];

    const capabilities = (this.state.qe.dialect as Dialect).insertCapabilities;
    const plan = this.buildInsertGraphPlan(graphs, capabilities);

    await selectExecutor(plan).execute();
    const roots = await this.materializeRootRows(plan);
    return Array.isArray(this.input)
      ? (roots as EntityInstance<C>[])
      : (roots[0] as EntityInstance<C>);
  }

  private buildInsertGraphPlan(
    graphs: Record<string, unknown>[],
    capabilities: DialectInsertCapabilities,
  ): InsertGraphPlan {
    const plan: InsertGraphPlan = {
      qe: this.state.qe,
      nodes: [],
      rootNodeIds: [],
    };

    const rootInfo = createEntityInfo(this.state.entity!);
    for (const graph of graphs) {
      const rootNode = this.planGraphNode(plan, capabilities, rootInfo, graph);
      plan.rootNodeIds.push(rootNode.id);
    }

    return plan;
  }

  private planGraphNode(
    plan: InsertGraphPlan,
    capabilities: DialectInsertCapabilities,
    entityInfo: InsertEntityInfo,
    graph: Record<string, unknown>,
  ): PlannedNode {
    const { scalarData, relationData } = splitGraphPayload(entityInfo, graph);
    const node = registerPlannedNode(plan, {
      tableName: entityInfo.tableName,
      entity: entityInfo.entity,
      scalarData,
      pkColumns: entityInfo.pkColumns,
      idResolution: resolveIdResolution(scalarData, entityInfo.pkColumns, capabilities),
    });

    for (const [relKey, relValue] of Object.entries(relationData)) {
      const relDef = assertKnownRelation(relKey, entityInfo);
      switch (relDef._relType) {
        case "one-to-one":
        case "many-to-one":
          assertRelationIsRecord(relKey, relDef._relType, relValue);
          this.planOwningToOneRelation(plan, capabilities, node, relDef, relValue);
          break;
        case "one-to-many":
          assertRelationIsArray(relKey, relDef._relType, relValue);
          this.planOneToManyChildren(plan, capabilities, node, relKey, relDef, relValue);
          break;
        case "many-to-many":
          assertRelationIsArray(relKey, relDef._relType, relValue);
          this.planManyToManyRelations(plan, capabilities, node, relKey, relDef, relValue);
          break;
      }
    }

    return node;
  }

  private planOwningToOneRelation(
    plan: InsertGraphPlan,
    capabilities: DialectInsertCapabilities,
    node: PlannedNode,
    relDef: RelationDef,
    relValue: Record<string, unknown>,
  ): void {
    const options = relDef._options as RelationOptions;
    const info = resolveTargetInfo(relDef);
    const parentNode = this.planGraphNode(plan, capabilities, info, relValue);
    addDependency(
      node,
      parentNode.id,
      getReferenceColumns(info, options),
      toArray(options.foreignKey),
    );
  }

  private planOneToManyChildren(
    plan: InsertGraphPlan,
    capabilities: DialectInsertCapabilities,
    node: PlannedNode,
    relKey: string,
    relDef: RelationDef,
    relValue: unknown[],
  ): void {
    const options = relDef._options as RelationOptions;
    const info = resolveTargetInfo(relDef);
    const fkColumns = toArray(options.foreignKey);
    for (const item of relValue) {
      assertChildIsRecord(relKey, item);
      const childNode = this.planGraphNode(plan, capabilities, info, item);
      addDependency(childNode, node.id, node.pkColumns, fkColumns);
    }
  }

  private planManyToManyRelations(
    plan: InsertGraphPlan,
    capabilities: DialectInsertCapabilities,
    node: PlannedNode,
    relKey: string,
    relDef: RelationDef,
    relValue: unknown[],
  ): void {
    const info = resolveTargetInfo(relDef);
    const junction = resolveJunctionInfo(relDef);

    for (const item of relValue) {
      assertChildIsRecord(relKey, item);
      const relatedNode = this.resolveManyToManyTargetNode(plan, capabilities, info, relKey, item);
      const junctionNode = this.createJunctionNode(plan, junction);
      addDependency(junctionNode, node.id, node.pkColumns, junction.fkColumns);
      addDependency(junctionNode, relatedNode.id, info.pkColumns, junction.refColumns);
    }
  }

  private resolveManyToManyTargetNode(
    plan: InsertGraphPlan,
    capabilities: DialectInsertCapabilities,
    info: InsertEntityInfo,
    relKey: string,
    item: Record<string, unknown>,
  ): PlannedNode {
    const referenceRow = parseManyToManyReference(relKey, info.pkColumns, item);
    if (referenceRow) {
      return this.createReferenceNode(plan, info.entity, info.pkColumns, referenceRow);
    }
    return this.planGraphNode(plan, capabilities, info, item);
  }

  private createJunctionNode(plan: InsertGraphPlan, junction: JunctionInfo): PlannedNode {
    return registerPlannedNode(plan, {
      tableName: junction.table,
      entity: junction.entity,
      scalarData: {},
      pkColumns: [],
      idResolution: "provided",
    });
  }

  private createReferenceNode(
    plan: InsertGraphPlan,
    targetEntity: AnyEntityClass,
    pkColumns: string[],
    referenceRow: Record<string, unknown>,
  ): PlannedNode {
    return registerPlannedNode(plan, {
      tableName: targetEntity.table._table,
      entity: targetEntity,
      scalarData: { ...referenceRow },
      pkColumns,
      idResolution: "provided",
      insertedRow: { ...referenceRow },
      materializedRow: { ...referenceRow },
    });
  }

  private async materializeRootRows(plan: InsertGraphPlan): Promise<Record<string, unknown>[]> {
    const roots: Record<string, unknown>[] = [];
    for (const nodeId of plan.rootNodeIds) {
      roots.push(await materializeRoot(plan, plan.nodes[nodeId]));
    }
    return roots;
  }
}

async function materializeRoot(
  plan: InsertGraphPlan,
  node: PlannedNode,
): Promise<Record<string, unknown>> {
  if (node.materializedRow) return node.materializedRow;
  if (!node.insertedRow) {
    throw new Error("insertGraph: root row was not inserted");
  }
  const refetched = await node.entity.query(plan.qe).findById(node.insertedRow);
  if (refetched == null) {
    throw new Error("insertGraph: insert succeeded but root row could not be fetched back");
  }
  node.materializedRow = refetched as Record<string, unknown>;
  return node.materializedRow;
}

function selectExecutor(plan: InsertGraphPlan): InsertGraphExecutor {
  const canBatch = plan.nodes.every((node) => node.idResolution !== "unresolvableInBatch");
  return canBatch ? new InsertGraphBatchExecutor(plan) : new InsertGraphSequentialExecutor(plan);
}

function createEntityInfo(entity: AnyEntityClass): InsertEntityInfo {
  return {
    tableName: entity.table._table,
    columnSet: new Set(Object.keys(entity.table._schema)),
    rels: entity.table._relations,
    pkColumns: getPkColumnsFromSchema(entity.table._schema),
    entity,
  };
}

function assertKnownRelation(relKey: string, entityInfo: InsertEntityInfo): RelationDef {
  const relDef = entityInfo.rels?.[relKey];
  if (!relDef) {
    throw new Error(
      `insertGraph: unknown relation "${relKey}" on entity "${entityInfo.tableName}"`,
    );
  }
  return relDef;
}

function assertRelationIsRecord(
  relKey: string,
  relType: RelationType,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`insertGraph: relation "${relKey}" (${relType}) expects an object`);
  }
}

function assertRelationIsArray(
  relKey: string,
  relType: RelationType,
  value: unknown,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`insertGraph: relation "${relKey}" (${relType}) expects an array`);
  }
}

function assertChildIsRecord(
  relKey: string,
  item: unknown,
): asserts item is Record<string, unknown> {
  if (!isRecord(item)) {
    throw new Error(`insertGraph: relation "${relKey}" array items must be objects`);
  }
}

function splitGraphPayload(
  entityInfo: InsertEntityInfo,
  graph: Record<string, unknown>,
): { scalarData: Record<string, unknown>; relationData: Record<string, unknown> } {
  const scalarData: Record<string, unknown> = {};
  const relationData: Record<string, unknown> = {};
  const { columnSet, rels, tableName } = entityInfo;

  for (const [key, value] of Object.entries(graph)) {
    if (value === undefined) continue;
    if (rels && key in rels) {
      relationData[key] = value;
    } else if (columnSet.has(key)) {
      scalarData[key] = value;
    } else {
      throw new Error(`insertGraph: unknown key "${key}" on entity "${tableName}"`);
    }
  }

  return { scalarData, relationData };
}

function resolveIdResolution(
  scalarData: Record<string, unknown>,
  pkColumns: string[],
  capabilities: DialectInsertCapabilities,
): GraphInsertIdResolution {
  if (pkColumns.every((column) => scalarData[column] !== undefined)) return "provided";
  if (capabilities.supportsReturning) return "needsReturning";
  if (capabilities.supportsSequences && pkColumns.length === 1) return "needsSequence";
  return "unresolvableInBatch";
}

function parseManyToManyReference(
  relKey: string,
  targetPkColumns: string[],
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  const pkSet = new Set(targetPkColumns);
  const pkKeys: string[] = [];
  const extraKeys: string[] = [];
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) continue;
    if (pkSet.has(key)) pkKeys.push(key);
    else extraKeys.push(key);
  }

  if (pkKeys.length === 0) return null;
  if (pkKeys.length < targetPkColumns.length) {
    throw new Error(
      `insertGraph: relation "${relKey}" expects either all target primary key fields or none`,
    );
  }
  if (extraKeys.length > 0) {
    throw new Error(
      `insertGraph: relation "${relKey}" reference objects may only contain primary key fields`,
    );
  }
  return data;
}

function getReferenceColumns(info: InsertEntityInfo, options: RelationOptions): string[] {
  if (options.references == null) return info.pkColumns;
  return toArray(options.references);
}

function resolveTargetInfo(relDef: RelationDef): InsertEntityInfo {
  return createEntityInfo(relDef._target() as AnyEntityClass);
}

type JunctionInfo = {
  table: string;
  entity: AnyEntityClass;
  fkColumns: string[];
  refColumns: string[];
};

function resolveJunctionInfo(relDef: RelationDef): JunctionInfo {
  const options = relDef._options as JunctionOptions;
  return {
    table: options.junction,
    entity: getEntityByTableName(options.junction) as AnyEntityClass,
    fkColumns: toArray(options.foreignKey),
    refColumns: toArray(options.referenceKey),
  };
}

function addDependency(
  node: PlannedNode,
  sourceNodeId: number,
  sourceColumns: string[],
  targetColumns: string[],
): void {
  node.dependencyIds.push(sourceNodeId);
  node.pendingCopies.push({ sourceNodeId, sourceColumns, targetColumns });
}

function registerPlannedNode(plan: InsertGraphPlan, fields: PlannedNodeInput): PlannedNode {
  const node: PlannedNode = {
    id: plan.nodes.length,
    dependencyIds: [],
    pendingCopies: [],
    ...fields,
  };
  plan.nodes.push(node);
  return node;
}
