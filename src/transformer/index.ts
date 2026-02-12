/**
 * TypeScript transformer for typhex: compiles .where(arrow) to .where(ir).
 * Use with ttypescript (ttsc) or ts-patch.
 *
 * tsconfig.json:
 *   "compilerOptions": { "plugins": [{ "transform": "typhex/transformer" }] }
 *
 * Or with ts-patch: add "ts-patch" and run with tsc (patched).
 */

import * as ts from "typescript";
import { createWhereTransformer } from "./where-transformer.js";

export default function (program: ts.Program) {
  return {
    before: createWhereTransformer(ts),
  };
}

export { createWhereTransformer };
