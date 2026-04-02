/**
 * Global default Db and entity registry.
 * - Db: set by Db constructor, fallback when entities don't have a per-entity Db.
 * - Registry: populated by Entity(), used by Db.migrate() / Db.validate().
 */

import type { Db } from "../orm/db.js";

let defaultDb: Db | null = null;

export function getDefaultDb(): Db | null {
  return defaultDb;
}

export function setDefaultDb(db: Db | null): void {
  defaultDb = db;
}

export interface RegisteredEntity {
  table: { _table: string; _schema: Record<string, string> };
}

const entityRegistry: RegisteredEntity[] = [];

export function registerEntity(entity: RegisteredEntity): void {
  entityRegistry.push(entity);
}

export function getRegisteredEntities(): readonly RegisteredEntity[] {
  return entityRegistry;
}

export function getEntityByTableName(tableName: string): RegisteredEntity | undefined {
  return entityRegistry.find((e) => e.table._table === tableName);
}

export function clearRegistry(): void {
  entityRegistry.length = 0;
}
