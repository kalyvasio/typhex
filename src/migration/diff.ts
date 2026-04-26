/**
 * Schema diff: compare registered entity definitions against the live database.
 * Delegates to the dialect's DbMigrations for dialect-specific diff logic.
 */

import type { Driver } from "../driver/types.js";
import type { DiffAction } from "./types.js";
import type { RegisteredEntity } from "../entity/global-driver.js";
import { getDbMigrations } from "../dbs/index.js";

export async function diffSchema(
  driver: Driver,
  entities: readonly RegisteredEntity[],
): Promise<DiffAction[]> {
  return getDbMigrations(driver.dialect).diffSchema(driver, entities);
}
