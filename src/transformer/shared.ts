/**
 * Barrel re-export for transformer shared utilities. Preserves the historical
 * `./shared.js` import path used by per-method transformers and vitest mocks.
 */

export { checkSymbolIsTyphex, isTyphexType } from "./typhex-type.js";
export { resolveMemberPath, memberPath, type ResolvedMember } from "./ts-member.js";
export { binaryOpFromSyntaxKind } from "./ts-binary.js";
export {
  getParamBindings,
  frameFromBindingName,
  type ParamBindings,
  type ScopeFrame,
} from "./bindings.js";
export {
  unwrapObjectLiteral,
  isIdentifierNamed,
  getArrowExpressionBody,
  matchTyphexMethodCall,
} from "./ts-utils.js";
export {
  parseTsAggregateCall,
  AGGREGATE_FUNCS,
  toIrFuncName,
  type TsAggregateParseResult,
} from "./ts-aggregates.js";
export {
  irNodeToTsLiteral,
  irWhereToTsLiteral,
  irOrderByToTsLiteral,
  irAggregateToTsLiteral,
  irSelectToTsLiteral,
} from "./ir-emit.js";
