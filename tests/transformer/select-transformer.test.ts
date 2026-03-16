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

  it("transforms (c) => ({ ...c, company: c.company }) to IR object with rest and relation", () => {
    expect(transform("contacts.select((c) => ({ ...c, company: c.company }));")).toMatchSnapshot();
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

  it("transforms (p) => p to select *", () => {
    expect(transform("users.select((p) => p);")).toMatchSnapshot();
  });

  it("transforms (p) => p.id to single column shorthand", () => {
    expect(transform("users.select((p) => p.id);")).toMatchSnapshot();
  });

  it("transforms (p) => count(p.id) to single aggregate shorthand", () => {
    expect(transform("users.select((p) => count(p.id));")).toMatchSnapshot();
  });

  it("transforms (p) => ({ category: p.category, total: sum(p.price) }) with aggregate", () => {
    expect(transform("products.select((p) => ({ category: p.category, total: sum(p.price) }));")).toMatchSnapshot();
  });

  it("transforms (p) => ({ cnt: count(p.id), maxSalary: max(p.salary) }) with multiple aggregates", () => {
    expect(transform("employees.select((p) => ({ cnt: count(p.id), maxSalary: max(p.salary) }));")).toMatchSnapshot();
  });

  it("transforms count(distinct(p.category)) single aggregate shorthand", () => {
    expect(transform("users.select((p) => count(distinct(p.category)));")).toMatchSnapshot();
  });

  it("transforms ({ unique: count(distinct(p.id)) }) object with distinct aggregate", () => {
    expect(transform("users.select((p) => ({ unique: count(distinct(p.id)) }));")).toMatchSnapshot();
  });

  it("transforms groupConcat(p.name, ', ') single aggregate shorthand", () => {
    expect(transform("users.select((p) => groupConcat(p.name, ', '));")).toMatchSnapshot();
  });

  it("transforms ({ names: groupConcat(p.name, ', ') }) object with groupConcat", () => {
    expect(transform("users.select((p) => ({ names: groupConcat(p.name, ', ') }));")).toMatchSnapshot();
  });
});
