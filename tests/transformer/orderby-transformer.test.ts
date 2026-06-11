/**
 * Unit tests for the orderBy transformer: source → transform → snapshot.
 */

import { describe, it, expect, vi } from "vitest";
import * as ts from "typescript";
import { createTyphexTransformer } from "../../src/transformer/index.js";

vi.mock("../../src/transformer/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/transformer/shared.js")>();
  return { ...actual, isTyphexType: () => true };
});

function transform(source: string): string {
  const program = ts.createProgram([], { noResolve: true, skipLibCheck: true });
  const sourceFile = ts.createSourceFile("test.ts", source, ts.ScriptTarget.ESNext, true);
  const result = ts.transform(sourceFile, [createTyphexTransformer(program)]);
  return ts.createPrinter().printFile(result.transformed[0] as ts.SourceFile);
}

describe("orderBy transformer", () => {
  it("transforms u => u.name to bare member IrOrderBy (regression)", () => {
    expect(transform(`users.orderBy(u => u.name);`)).toMatchSnapshot();
  });

  it("transforms u => u.featured ? 0 : 1 to expr-bearing IrOrderBy (ternary)", () => {
    expect(transform(`users.orderBy(u => u.featured ? 0 : 1);`)).toMatchSnapshot();
  });

  it("transforms u => u.price * u.qty with 'desc' to expr-bearing IrOrderBy (arithmetic)", () => {
    expect(transform(`orders.orderBy(u => u.price * u.qty, "desc");`)).toMatchSnapshot();
  });

  it("emits closure capture vars as second arg", () => {
    expect(transform(`const c = 5; orders.orderBy((u) => (u.qty < c ? 0 : 1));`)).toMatchSnapshot();
  });
});
