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
import { frameFromBindingName, type ScopeFrame } from "./shared.js";

/**
 * Recursive visitor: for every CallExpression, visit children first (so
 * nested chains are rewritten inside-out) and then try each per-method
 * transformer in turn. Non-call nodes are walked through unchanged.
 *
 * `scope` is a stack of `ScopeFrame`s from enclosing arrow functions — each
 * frame carries the row-param name and any destructured bindings. Per-method
 * transformers consult it so a bare identifier that matches an outer arrow's
 * param resolves as an `IrMember` reference (rather than a closure capture).
 * This is what lets correlated subqueries like `p.userId === u.id` and
 * destructured-outer cases like `({ id }) => p.userId === id` work without
 * any per-call rethreading.
 */
function visit(
  node: ts.Node,
  ctx: ts.TransformationContext,
  checker: ts.TypeChecker,
  scope: ScopeFrame[],
): ts.Node {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const frames: ScopeFrame[] = [];
    for (const p of node.parameters) {
      const frame = frameFromBindingName(p.name);
      if (frame) frames.push(frame);
    }
    const innerScope = frames.length > 0 ? [...scope, ...frames] : scope;
    return ts.visitEachChild(node, (n) => visit(n, ctx, checker, innerScope), ctx);
  }

  if (ts.isCallExpression(node)) {
    // Visit children first so nested calls get transformed inside-out.
    // Inner `.where(arrow)` and `.select(arrow)` are rewritten to IR
    // object-literal expressions before this outer call is matched, so the
    // chain walker for inline subqueries consumes already-transformed IR
    // literals rather than re-parsing the inner arrows.
    const visited = ts.visitEachChild(node, (n) => visit(n, ctx, checker, scope), ctx);

    const rewritten =
      transformSelectCall(visited, checker, scope) ||
      transformWhereCall(visited, checker, scope) ||
      transformOrderByCall(visited, checker, scope) ||
      transformJoinCall(visited, checker) ||
      transformHavingCall(visited, checker, scope);

    if (rewritten) return rewritten;
    return visited;
  }
  return ts.visitEachChild(node, (n) => visit(n, ctx, checker, scope), ctx);
}

/** Entry point for a single source file — walks its top-level children through `visit`. */
function visitSourceFile(
  node: ts.SourceFile,
  ctx: ts.TransformationContext,
  checker: ts.TypeChecker,
): ts.SourceFile {
  return ts.visitEachChild(node, (n) => visit(n, ctx, checker, []), ctx);
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
