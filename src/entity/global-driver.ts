/**
 * Global default driver and entity registry.
 * - Driver: set by Db constructor, fallback when entities don't have a per-entity driver.
 * - Registry: populated by Entity(), used by Db.migrate() / Db.validate().
 */

import type { Driver } from "../driver/types.js";

let defaultDriver: Driver | null = null;

export function getDefaultDriver(): Driver | null {
  return defaultDriver;
}

export function setDefaultDriver(driver: Driver | null): void {
  defaultDriver = driver;
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
