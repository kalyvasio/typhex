/**
 * Relation join resolution: extract relations from where IR and build JOIN metadata.
 * When a relation is referenced in where (e.g. p.author.name === "Alice"), emit a JOIN
 * instead of failing on non-existent column.
 */

import type { IrExists, JoinHint, JoinType } from "../../../ir/types.js";
import type { RelationsMap, RelationDef, JunctionOptions } from "../../../entity/relations.js";
import { toArray } from "../../../utils.js";

export interface RelationJoinInfo {
  relationKey: string;
  alias: string;
  targetTable: string;
  targetPkColumns: string[];
  foreignKeys: string[];
  relType: "many-to-one" | "one-to-one";
  joinType: JoinType;
}

export interface OneToManyExistsInfo {
  targetTable: string;
  fkColumns: string[];
  mainPk: string[];
  alias: string;
}

export interface RelationJoinContext {
  relations: RelationsMap;
  tableName: string;
  columnNames: string[];
  pkColumns: string[];
  resolveTarget: (rel: RelationDef) => { table: string; pk: string[] } | null;
}

/**
 * Builds EXISTS metadata for one-to-many relations in the where clause.
 * One-to-many uses EXISTS instead of JOIN to avoid row duplication.
 */
export class OneToManyExistsBuilder {
  private aliasIndex = 0;

  constructor(
    private readonly existsNodes: IrExists[],
    private readonly relations: RelationsMap,
    private readonly rootParam: string,
    private readonly mainPk: string[],
    private readonly resolveTarget: (rel: RelationDef) => { table: string; pk: string[] } | null,
    private readonly aliasPrefix = "ex",
  ) {}

  build(): Record<string, OneToManyExistsInfo> {
    const result: Record<string, OneToManyExistsInfo> = {};

    for (const node of this.existsNodes) {
      if (node.rootParam !== this.rootParam) continue;
      const key = `${this.rootParam}.${node.relationKey}`;
      if (result[key]) continue;
      result[key] = this.buildExistsInfo(node);
    }

    return result;
  }

  private buildExistsInfo(node: IrExists): OneToManyExistsInfo {
    const rel = this.relations[node.relationKey];
    if (!rel) {
      throw new Error(
        `[typhex] where relation "${node.relationKey}" is not defined on this entity`,
      );
    }
    if (rel._relType !== "one-to-many") {
      throw new Error(
        `[typhex] where relation "${node.relationKey}" must be one-to-many to use .some()/.every()`,
      );
    }
    if (this.mainPk.length === 0) {
      throw new Error(
        `[typhex] where relation "${node.relationKey}" requires a primary key on the parent entity`,
      );
    }

    const target = this.resolveTarget(rel)!;
    const opts = rel._options;
    return {
      targetTable: target.table,
      fkColumns: toArray(opts.foreignKey),
      mainPk: this.mainPk,
      alias: `${this.aliasPrefix}${this.aliasIndex++}`,
    };
  }
}

/**
 * Builds JOIN metadata for relations used in the where clause or orderBy.
 * Relations used only in select are loaded via whereIn; select IR is not consulted here.
 */
export class RelationJoinBuilder {
  private aliasIndex = 1;

  constructor(
    private readonly ctx: RelationJoinContext,
    private readonly relationKeys: Set<string>,
    private readonly joinHints?: JoinHint[],
  ) {}

  build(): RelationJoinInfo[] {
    const result: RelationJoinInfo[] = [];

    for (const relKey of this.relationKeys) {
      const join = this.buildJoin(relKey);
      if (join) result.push(join);
    }

    return result;
  }

  private buildJoin(relKey: string): RelationJoinInfo | null {
    const rel = this.ctx.relations[relKey] as RelationDef | undefined;
    if (!rel) return null;

    const opts = rel._options;
    if ((opts as JunctionOptions).junction) return null;

    const relType = rel._relType;
    if (relType !== "many-to-one" && relType !== "one-to-one") return null;

    const target = this.ctx.resolveTarget(rel);
    if (!target) return null;

    const foreignKeys = opts.foreignKey ? toArray(opts.foreignKey) : [];
    if (foreignKeys.length === 0) return null;

    return {
      relationKey: relKey,
      alias: `t${this.aliasIndex++}`,
      targetTable: target.table,
      targetPkColumns: target.pk,
      foreignKeys,
      relType,
      joinType: this.resolveJoinType(relKey),
    };
  }

  private resolveJoinType(relKey: string): JoinType {
    const hint = this.joinHints
      ?.slice()
      .reverse()
      .find((h) => h.relationKey === relKey);
    return hint?.joinType ?? "left";
  }
}

/** Builds a lookup from `${param}.${relationKey}` to the JOIN alias. */
export class RelationPathAliasBuilder {
  constructor(
    private readonly joins: RelationJoinInfo[],
    private readonly params: string[],
  ) {}

  build(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const join of this.joins) {
      for (const param of this.params) {
        map[`${param}.${join.relationKey}`] = join.alias;
      }
    }
    return map;
  }
}
