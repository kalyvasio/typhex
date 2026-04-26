/**
 * Global default Db and entity registry.
 * - Db: set by Db constructor, fallback when entities don't have a per-entity Db.
 * - Registry: populated by Entity(), used by Db.migrate() / Db.validate().
 */

import type { Db } from "../orm/db.js";
import type { JunctionOptions } from "./relations.js";
import { extractBaseType, toArray } from "../utils.js";

let defaultDb: Db | null = null;

export function getDefaultDb(): Db | null {
  return defaultDb;
}

export function setDefaultDb(db: Db | null): void {
  defaultDb = db;
}

export interface RegisteredEntity {
  table: { _table: string; _schema: Record<string, string> };
  _registerJunctions?: () => void;
}

export interface PendingJunction {
  sourceTable: string;
  sourceSchema: Record<string, string>;
  sourcePkCols: string[];
  options: JunctionOptions;
  resolveTarget: () => { table: string; pk: string[]; schema: Record<string, string> } | null;
  /** Materialize the junction entity given a fully-built schema. Captured at enqueue time so finalize doesn't need to import Entity (avoids cycle). */
  materialize: (junctionSchema: Record<string, string>) => void;
}

const entityRegistry: RegisteredEntity[] = [];

class JunctionRegistry {
  private pending: PendingJunction[] = [];
  private draining = false;

  enqueue(p: PendingJunction): void {
    this.pending.push(p);
  }

  drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      let progress = true;
      while (progress && this.pending.length > 0) {
        progress = false;
        const remaining: PendingJunction[] = [];
        for (const p of this.pending) {
          if (this.tryMaterialize(p)) progress = true;
          else remaining.push(p);
        }
        this.pending = remaining;
      }
    } finally {
      this.draining = false;
    }
  }

  assertAllResolved(): void {
    if (this.pending.length === 0) return;
    const lines = this.pending.map(
      (p) =>
        `  - junction "${p.options.junction}" for ${p.sourceTable}.${asKey(p.options.foreignKey)} ↔ ${asKey(p.options.referenceKey)} (target entity not registered)`,
    );
    throw new Error(
      `manyToMany: cannot finalize ${this.pending.length} junction table(s):\n${lines.join("\n")}\n` +
        `Register the target entity before calling migrate()/validate(), or define the junction entity explicitly.`,
    );
  }

  clear(): void {
    this.pending = [];
    this.draining = false;
  }

  private tryMaterialize(p: PendingJunction): boolean {
    if (getEntityByTableName(p.options.junction)) return true;
    const target = p.resolveTarget();
    if (!target) return false;
    const schema = buildJunctionSchema(p, target);
    p.materialize(schema);
    return true;
  }
}

function asKey(k: string | string[]): string {
  return Array.isArray(k) ? `[${k.join(", ")}]` : k;
}

function buildJunctionSchema(
  p: PendingJunction,
  target: { table: string; pk: string[]; schema: Record<string, string> },
): Record<string, string> {
  const fkCols = toArray(p.options.foreignKey);
  const refCols = toArray(p.options.referenceKey);
  assertColumnCount(fkCols, p.sourcePkCols, p.sourceTable, p.options.junction, "foreignKey");
  assertColumnCount(refCols, target.pk, target.table, p.options.junction, "referenceKey");

  const out: Record<string, string> = {};
  for (let i = 0; i < fkCols.length; i++) {
    out[fkCols[i]] = `${extractBaseType(p.sourceSchema[p.sourcePkCols[i]])} not null`;
  }
  for (let i = 0; i < refCols.length; i++) {
    out[refCols[i]] = `${extractBaseType(target.schema[target.pk[i]])} not null`;
  }
  return out;
}

function assertColumnCount(
  junctionCols: string[],
  refPkCols: string[],
  refTable: string,
  junctionName: string,
  side: "foreignKey" | "referenceKey",
): void {
  if (junctionCols.length === refPkCols.length) return;
  throw new Error(
    `manyToMany: junction "${junctionName}" ${side} has ${junctionCols.length} column(s) ` +
      `but referenced entity "${refTable}" has ${refPkCols.length} primary key column(s). ` +
      `They must match positionally.`,
  );
}

const junctionRegistry = new JunctionRegistry();

export function enqueuePendingJunction(p: PendingJunction): void {
  junctionRegistry.enqueue(p);
}

export function registerEntity(entity: RegisteredEntity): void {
  entityRegistry.push(entity);
  entity._registerJunctions?.();
}

export function getRegisteredEntities(): readonly RegisteredEntity[] {
  junctionRegistry.drain();
  junctionRegistry.assertAllResolved();
  return entityRegistry;
}

export function getEntityByTableName(tableName: string): RegisteredEntity | undefined {
  return entityRegistry.find((e) => e.table._table === tableName);
}

export function clearRegistry(): void {
  entityRegistry.length = 0;
  junctionRegistry.clear();
}
