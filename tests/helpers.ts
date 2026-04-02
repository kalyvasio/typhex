import { createSqliteDriver } from "../src/driver/sqlite.js";
import { Db } from "../src/orm/db.js";
import type { Driver } from "../src/driver/types.js";
import { vi } from "vitest";

export function freshDriver(): Driver {
  return createSqliteDriver({ path: ":memory:" });
}

export function freshDb(): Db {
  return new Db(freshDriver());
}

export type MockDb = Db;

export function createMockDb(): Db {
  return {
    dialect: "sqlite",
    query: vi.fn().mockReturnValue([]),
    run: vi.fn().mockReturnValue({ lastID: 1, changes: 0 }),
    connect: vi.fn().mockResolvedValue({
      dialect: "sqlite",
      execute: vi.fn().mockResolvedValue({ rows: [], lastID: 1, changes: 0 }),
      release: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn(),
    transaction: vi.fn().mockImplementation(async (fn: (trx: unknown) => Promise<unknown>) => fn({})),
    getDriver: vi.fn().mockReturnValue({ dialect: "sqlite" }),
  } as unknown as Db;
}
