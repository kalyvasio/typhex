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
import { transformWhereCall } from "./where-transformer.js";
import { transformSelectCall } from "./select-transformer.js";

function visit(
  node: ts.Node,
  ctx: ts.TransformationContext,
  checker: ts.TypeChecker
): ts.Node {
  if (ts.isCallExpression(node)) {
    // Visit children first so nested calls (e.g. users.select(...).where(...)) get transformed from the inside out
    const visited = ts.visitEachChild(node, (n) => visit(n, ctx, checker), ctx) as ts.CallExpression;
    
    // Try each transformer in order
    const rewritten = transformSelectCall(visited, checker) 
      || transformWhereCall(visited, checker);
    
    if (rewritten) return rewritten;
    return visited;
  }
  return ts.visitEachChild(node, (n) => visit(n, ctx, checker), ctx);
}

function visitSourceFile(
  node: ts.SourceFile,
  ctx: ts.TransformationContext,
  checker: ts.TypeChecker
): ts.SourceFile {
  return ts.visitEachChild(node, n => visit(n, ctx, checker), ctx) as ts.SourceFile;
}

/** Create the main Typhex transformer. */
export function createTyphexTransformer(program: ts.Program) {
  const checker = program.getTypeChecker();
  
  return (ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sf: ts.SourceFile) => visitSourceFile(sf, ctx, checker);
  };
}

export default function (program: ts.Program) {
  return {
    before: createTyphexTransformer(program),
  };
}
