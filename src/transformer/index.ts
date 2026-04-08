/**
 * TypeScript transformer for typhex: compiles .where(arrow) and .select(arrow) to IR.
 * Use with ttypescript (ttsc) or ts-patch.
 *
 * tsconfig.json:
 *   "compilerOptions": { "plugins": [{ "transform": "typhex/transformer" }] }
 *
 * Or with ts-patch: add "ts-patch" and run with tsc (patched).
 */

import * as ts from "typescript";
import { transformWhereCall, transformHavingCall } from "./where-transformer.js";
import { transformSelectCall } from "./select-transformer.js";
import { transformOrderByCall } from "./orderby-transformer.js";
import { transformJoinCall } from "./join-transformer.js";

/**
 * Recursive visitor: for every CallExpression, visit children first (so
 * nested chains are rewritten inside-out) and then try each per-method
 * transformer in turn. Non-call nodes are walked through unchanged.
 */
function visit(
  node: ts.Node,
  ctx: ts.TransformationContext,
  checker: ts.TypeChecker
): ts.Node {
  if (ts.isCallExpression(node)) {
    // Visit children first so nested calls (e.g. users.select(...).where(...)) get transformed from the inside out
    const visited = ts.visitEachChild(node, (n) => visit(n, ctx, checker), ctx);
    
    // Try each transformer in order
    const rewritten = transformSelectCall(visited, checker)
      || transformWhereCall(visited, checker)
      || transformOrderByCall(visited, checker)
      || transformJoinCall(visited, checker)
      || transformHavingCall(visited, checker);
    
    if (rewritten) return rewritten;
    return visited;
  }
  return ts.visitEachChild(node, (n) => visit(n, ctx, checker), ctx);
}

/** Entry point for a single source file — walks its top-level children through `visit`. */
function visitSourceFile(
  node: ts.SourceFile,
  ctx: ts.TransformationContext,
  checker: ts.TypeChecker
): ts.SourceFile {
  return ts.visitEachChild(node, n => visit(n, ctx, checker), ctx);
}

/** Create the main Typhex transformer. */
export function createTyphexTransformer(program: ts.Program) {
  const checker = program.getTypeChecker();
  
  return (ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sf: ts.SourceFile) => visitSourceFile(sf, ctx, checker);
  };
}

/** ttsc/ts-patch plugin entry point — wires the transformer into the `before` phase. */
export default function (program: ts.Program) {
  return {
    before: createTyphexTransformer(program),
  };
}
