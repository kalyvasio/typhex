/**
 * Schema diff: compare registered entity definitions against the live database.
 * Delegates to the dialect's BaseMigrations subclass for dialect-specific diff logic.
 */

import type { Driver } from "../driver/types.js";
import type { DiffAction } from "./types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";

/** Compares entity definitions against the live database schema and returns the list of pending `DiffAction` items. */
export async function diffSchema(
  driver: Driver,
  entities: readonly RegisteredEntity[],
): Promise<DiffAction[]> {
  return driver.dialect.migrations.diffSchema(driver, entities);
}
