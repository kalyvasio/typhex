/**
 * Unit tests for the select transformer: source → transform → snapshot.
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

describe("select transformer", () => {
  it("transforms (u) => ({ id: u.id, name: u.name }) to IR object", () => {
    expect(transform("users.select((u) => ({ id: u.id, name: u.name }));")).toMatchSnapshot();
  });

  it("transforms ({ id, name }) => ({ id, name }) to IR object", () => {
    expect(transform("users.select(({ id, name }) => ({ id, name }));")).toMatchSnapshot();
  });

  it("transforms ({ id, ...rest }) => ({ id, ...rest }) to IR object with rest", () => {
    expect(transform("users.select(({ id, ...rest }) => ({ id, ...rest }));")).toMatchSnapshot();
  });

  it("transforms (u) => ({ userId: u.id, fullName: u.name, country: u.country }) with aliases", () => {
    expect(
      transform(
        "users.select((u) => ({ userId: u.id, fullName: u.name, country: u.country }));"
      )
    ).toMatchSnapshot();
  });

  it("transforms (u) => ({ id: u.id }) single column", () => {
    expect(transform("users.select((u) => ({ id: u.id }));")).toMatchSnapshot();
  });

  it("transforms (u) => ({ userId: u.id }) single column with alias", () => {
    expect(transform("users.select((u) => ({ userId: u.id }));")).toMatchSnapshot();
  });
});
