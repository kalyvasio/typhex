/**
 * Barrel re-export for runtime arrow → IR parsing. Preserves the historical
 * `parse-arrow.js` import path used by tests and `src/parser/resolve.ts`.
 */

export type { ParseOptions } from "./predicate-walk.js";
export { parseArrowToIr, parseArrowToIrPredicate } from "./predicate-walk.js";
export { parseArrowToGroupByPaths } from "./group-by.js";
export { parseArrowToIrSelect } from "./select.js";
export { parseArrowToUpdateSet } from "./update.js";
