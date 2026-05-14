/**
 * Parity tests: verify that the runtime parser (acorn) and compile-time
 * transformer (TS AST) produce identical IR for the same input expressions.
 *
 * The transformer is exercised via the existing test helper that compiles
 * source strings. The runtime parser is called directly with arrow functions.
 * We compare the resulting IR structures.
 */

import { describe, it, expect, vi } from "vitest";
import * as ts from "typescript";
import { createTyphexTransformer } from "../../src/transformer/index.js";
import { parseArrowToIrPredicate } from "../../src/parser/parse-arrow.js";
import type { IrWhere } from "../../src/ir/types.js";

vi.mock("../../src/transformer/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/transformer/shared.js")>();
  return { ...actual, isTyphexType: () => true };
});

function transformToIr(source: string): IrWhere | null {
  const program = ts.createProgram([], { noResolve: true, skipLibCheck: true });
  const sourceFile = ts.createSourceFile("test.ts", source, ts.ScriptTarget.ESNext, true);
  const result = ts.transform(sourceFile, [createTyphexTransformer(program)]);
  const printed = ts.createPrinter().printFile(result.transformed[0] as ts.SourceFile);

  const match = printed.match(/\.where\((\{[\s\S]+?\})\s*,\s*\{/);
  if (!match) return null;
  try {
    return new Function(`return ${match[1]}`)() as IrWhere;
  } catch {
    return null;
  }
}

describe("parity: runtime parser vs compile-time transformer", () => {
  const cases: Array<{
    name: string;
    source: string;
    fn: (...args: any[]) => any;
    options?: { paramNames?: string[]; paramKeys?: string[] };
  }> = [
    {
      name: "simple comparison: u.age > 18",
      source: "users.where((u) => u.age > 18);",
      fn: (u: { age: number }) => u.age > 18,
    },
    {
      name: 'equality: u.country === "US"',
      source: 'users.where((u) => u.country === "US");',
      fn: (u: { country: string }) => u.country === "US",
    },
    {
      name: "logical and: u.age >= 18 && u.active",
      source: "users.where((u) => u.age >= 18 && u.active);",
      fn: (u: { age: number; active: boolean }) => u.age >= 18 && u.active,
    },
    {
      name: "negation: !u.active",
      source: "users.where((u) => !u.active);",
      fn: (u: { active: boolean }) => !u.active,
    },
    {
      name: "startsWith call",
      source: 'users.where((u) => u.name.startsWith("A"));',
      fn: (u: { name: string }) => u.name.startsWith("A"),
    },
    {
      name: "in operator: u.id in [1, 2]",
      source: "users.where((u) => u.id in [1, 2]);",
      fn: (u: { id: number }) => u.id in [1, 2],
    },
    {
      name: "equality with number: u.id === 1",
      source: "users.where((u) => u.id === 1);",
      fn: (u: { id: number }) => u.id === 1,
    },
    {
      name: "or expression: u.a || u.b",
      source: "users.where((u) => u.a || u.b);",
      fn: (u: { a: boolean; b: boolean }) => u.a || u.b,
    },
    {
      name: "relation.some(): d.employees.some((e) => e.name === 'Alice')",
      source: 'depts.where((d) => d.employees.some((e) => e.name === "Alice"));',
      fn: (d: { employees: { name: string }[] }) => d.employees.some((e) => e.name === "Alice"),
      options: { paramNames: ["d"] },
    },
  ];

  for (const { name, source, fn, options } of cases) {
    it(`produces identical IR: ${name}`, () => {
      const transformerIr = transformToIr(source);
      const runtimeIr = parseArrowToIrPredicate(fn, options);
      expect(transformerIr).not.toBeNull();
      expect(runtimeIr).toEqual(transformerIr);
    });
  }
});
