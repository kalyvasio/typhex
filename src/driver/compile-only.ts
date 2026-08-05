/**
 * Compile-only mode: when TYPHEX_COMPILE_ONLY is set, driver factories return a
 * stub driver that carries the full dialect (so `toSql()` works) but never opens
 * a real connection and refuses to execute SQL. Intended for tooling that needs
 * to extract SQL from application code without touching a database.
 */

import type { Dialect } from "../dbs/types.js";
import type { Driver } from "./types.js";

/** @internal */
export function isCompileOnlyEnabled(): boolean {
  const flag = process?.env?.TYPHEX_COMPILE_ONLY;
  return flag === "1" || flag === "true" || flag === "yes";
}

/** @internal */
export function createCompileOnlyDriver(dialect: Dialect): Driver {
  const refuse = (): never => {
    throw new Error(
      "[typhex] TYPHEX_COMPILE_ONLY is set: refusing to open a connection or execute SQL. " +
        "Unset TYPHEX_COMPILE_ONLY to run queries.",
    );
  };
  return {
    dialect,
    execute: async () => refuse(),
    connect: async () => refuse(),
    createTrx: refuse,
    close: async () => {},
  };
}
