/**
 * Unit tests for the where transformer: source → transform → snapshot.
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

/** Like transform() but builds a real program from the source so the type checker
 *  can resolve static properties (needed for inline subquery tableName extraction). */
function transformWithChecker(source: string): string {
  const fileName = "test.ts";
  const host = ts.createCompilerHost({ skipLibCheck: true, noLib: true });
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) =>
    name === fileName
      ? ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true)
      : orig(name, lang);
  const program = ts.createProgram([fileName], { skipLibCheck: true, noLib: true }, host);
  const sf = program.getSourceFile(fileName)!;
  const result = ts.transform(sf, [createTyphexTransformer(program)]);
  return ts.createPrinter().printFile(result.transformed[0] as ts.SourceFile);
}

describe("where transformer", () => {
  it('transforms (u) => u.country === "US"', () => {
    expect(transform('users.where((u) => u.country === "US");')).toMatchSnapshot();
  });

  it("transforms (u) => u.age >= minAge && u.age <= maxAge with closure vars", () => {
    expect(
      transform(
        "const minAge = 25; const maxAge = 35; users.where((u) => u.age >= minAge && u.age <= maxAge);",
      ),
    ).toMatchSnapshot();
  });

  it('transforms (u) => u.name.startsWith("A")', () => {
    expect(transform('users.where((u) => u.name.startsWith("A"));')).toMatchSnapshot();
  });

  it('transforms (u) => u.name.includes("al")', () => {
    expect(transform('users.where((u) => u.name.includes("al"));')).toMatchSnapshot();
  });

  it("transforms (u) => u.id in [1, 2]", () => {
    expect(transform("users.where((u) => u.id in [1, 2]);")).toMatchSnapshot();
  });

  it("transforms (u) => !(u.id in [2])", () => {
    expect(transform("users.where((u) => !(u.id in [2]));")).toMatchSnapshot();
  });

  it("transforms (u) => u.id === 1 simple equality", () => {
    expect(transform("users.where((u) => u.id === 1);")).toMatchSnapshot();
  });

  it("transforms (d) => d.employees.some((e) => e.name === 'Alice')", () => {
    expect(
      transform("depts.where((d) => d.employees.some((e) => e.name === 'Alice'));"),
    ).toMatchSnapshot();
  });
});

describe("having transformer", () => {
  it("transforms (p) => count(p.id) > 5", () => {
    expect(transform("orders.having((p) => count(p.id) > 5);")).toMatchSnapshot();
  });

  it("transforms (p) => sum(p.price) >= minAmount with closure var", () => {
    expect(
      transform("const minAmount = 100; orders.having((p) => sum(p.price) >= minAmount);"),
    ).toMatchSnapshot();
  });

  it("transforms (p) => avg(p.salary) > 50000 && count(p.id) > 10", () => {
    expect(
      transform("employees.having((p) => avg(p.salary) > 50000 && count(p.id) > 10);"),
    ).toMatchSnapshot();
  });

  it("transforms (p) => count(distinct(p.category)) > 3 with distinct", () => {
    expect(transform("orders.having((p) => count(distinct(p.category)) > 3);")).toMatchSnapshot();
  });

  it("transforms inline subquery: (a) => a.postId in Post.query().where(...).select(p => p.id)", () => {
    const source = `
class Post { static tableName: "posts" = "posts"; static query(): any { return null as any; } }
authors.where((a: any) => a.postId in Post.query().where((p: any) => p.active === true).select((p: any) => p.id));
`;
    expect(transformWithChecker(source)).toMatchSnapshot();
  });

  it("transforms ({ id }) => id > 5 — destructured outer where arrow", () => {
    expect(transform("users.where(({ id }: any) => id > 5);")).toMatchSnapshot();
  });

  it("transforms destructured outer where with correlated inline subquery comparison", () => {
    const source = `
class Post { static tableName: "posts" = "posts"; static query(): any { return null as any; } }
authors.where(({ id }: any) => Post.query().where((p: any) => p.authorId === id).count() > 5);
`;
    expect(transformWithChecker(source)).toMatchSnapshot();
  });

  it("transforms member access on destructured local — ({ author }) => author.id === 1", () => {
    expect(transform("rows.where(({ author }: any) => author.id === 1);")).toMatchSnapshot();
  });
});
