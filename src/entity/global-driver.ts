/**
 * Global default Db and entity registry.
 * - Db: set by Db constructor, fallback when entities don't have a per-entity Db.
 * - Registry: populated by Entity(), used by schema operations when Db has no explicit entities.
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

export function clearDefaultDb(db: Db): void {
  if (defaultDb === db) defaultDb = null;
}

/** Minimal view of an entity class as held in the global registry. */
export interface RegisteredEntity {
  /** Table name and schema, used for migrations and validation. */
  table: { _table: string; _schema: Record<string, string> };
  /** Wires up many-to-many junction relations. */
  _registerJunctions?: () => void;
}

export interface PendingJunction {
  sourceTable: string;
  sourceSchema: Record<string, string>;
  sourcePkCols: string[];
  options: JunctionOptions;
  resolveTarget: () => { table: string; pk: string[]; schema: Record<string, string> } | null;
  /** Materialize the junction entity given a fully-built schema. Captured at enqueue time so finalize doesn't need to import Entity (avoids cycle). */
  materialize: (junctionSchema: Record<string, string>) => RegisteredEntity;
}

const entityRegistry: RegisteredEntity[] = [];

class JunctionRegistry {
  private pending: PendingJunction[] = [];
  private materialized = new Set<RegisteredEntity>();
  private draining = false;

  enqueue(p: PendingJunction): void {
    if (
      this.pending.some(
        (existing) =>
          existing.sourceTable === p.sourceTable &&
          existing.options.junction === p.options.junction,
      )
    ) {
      return;
    }
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
    this.materialized.clear();
    this.draining = false;
  }

  finalizeFor(entities: readonly RegisteredEntity[]): readonly RegisteredEntity[] {
    const resolved = new Map(entities.map((entity) => [entity.table._table, entity]));
    for (const entity of entities) entity._registerJunctions?.();

    const remaining: PendingJunction[] = [];
    for (const pending of this.pending) {
      if (!resolved.has(pending.sourceTable)) {
        remaining.push(pending);
        continue;
      }

      const target = pending.resolveTarget();
      if (!target) {
        throw new Error(
          `manyToMany: cannot finalize junction "${pending.options.junction}" for explicit Db entities: ` +
            `target entity for "${pending.sourceTable}" is not available.`,
        );
      }
      if (!resolved.has(target.table)) {
        throw new Error(
          `manyToMany: explicit Db entities must include target entity "${target.table}" ` +
            `for junction "${pending.options.junction}".`,
        );
      }

      const existing =
        resolved.get(pending.options.junction) ??
        [...this.materialized].find((entity) => entity.table._table === pending.options.junction);
      const registered = entityRegistry.find(
        (entity) => entity.table._table === pending.options.junction,
      );
      if (!existing && registered) {
        throw new Error(
          `manyToMany: explicit Db entities must include junction entity ` +
            `"${pending.options.junction}" because it was defined explicitly.`,
        );
      }
      const junction = existing ?? pending.materialize(buildJunctionSchema(pending, target));
      if (!existing) this.materialized.add(junction);
      resolved.set(junction.table._table, junction);
    }
    this.pending = remaining;

    return [...resolved.values()];
  }

  private tryMaterialize(p: PendingJunction): boolean {
    if (getEntityByTableName(p.options.junction)) return true;
    const target = p.resolveTarget();
    if (!target) return false;
    const schema = buildJunctionSchema(p, target);
    this.materialized.add(p.materialize(schema));
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

export function finalizeEntityCollection(
  entities: readonly RegisteredEntity[],
): readonly RegisteredEntity[] {
  return junctionRegistry.finalizeFor(entities);
}

export function getEntityByTableName(tableName: string): RegisteredEntity | undefined {
  // Junction entities materialize lazily; without this, lookups fail before migrate()/validate().
  junctionRegistry.drain();
  return entityRegistry.find((e) => e.table._table === tableName);
}

export function clearRegistry(): void {
  entityRegistry.length = 0;
  junctionRegistry.clear();
}
