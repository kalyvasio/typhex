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
});
