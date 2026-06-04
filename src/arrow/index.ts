/**
 * Barrel re-export for shared arrow-expression language rules (constants,
 * aggregate naming). Imported by `src/parser/*` and `src/transformer/*`.
 */

export {
  DEFAULT_ROW_PARAM,
  ALLOWED_METHODS,
  RELATION_QUERY_METHODS,
  ACORN_BINARY_OPS,
} from "./constants.js";
export { AGGREGATE_FUNCS, toIrFuncName, isAggregateFunc } from "./aggregates.js";
