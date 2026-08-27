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
import { parseArrowToIrPredicate, parseArrowToIrSelect } from "../../src/parser/parse-arrow.js";
import type { IrSelect, IrWhere } from "../../src/ir/types.js";

vi.mock("../../src/transformer/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/transformer/shared.js")>();
  return { ...actual, isTyphexType: () => true };
});

function transformSource(source: string): ts.SourceFile {
  const program = ts.createProgram([], { noResolve: true, skipLibCheck: true });
  const sourceFile = ts.createSourceFile("test.ts", source, ts.ScriptTarget.ESNext, true);
  const result = ts.transform(sourceFile, [createTyphexTransformer(program)]);
  return result.transformed[0] as ts.SourceFile;
}

function transformToIr(source: string): IrWhere | null {
  const sourceFile = transformSource(source);
  const statement = sourceFile.statements.at(-1);
  if (!statement || !ts.isExpressionStatement(statement)) return null;
  if (!ts.isCallExpression(statement.expression)) return null;
  const arg = statement.expression.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;

  const printed = ts.createPrinter().printNode(ts.EmitHint.Expression, arg, sourceFile);
  return new Function(`return ${printed}`)() as IrWhere;
}

function transformSelectToIr(source: string): IrSelect | null {
  const sourceFile = transformSource(source);
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return null;
  if (!ts.isCallExpression(statement.expression)) return null;
  const arg = statement.expression.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;

  const printed = ts.createPrinter().printNode(ts.EmitHint.Expression, arg, sourceFile);
  return new Function(`return ${printed}`)() as IrSelect;
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
    {
      name: "relation.every(): d.employees.every((e) => e.active)",
      source: "depts.where((d) => d.employees.every((e) => e.active === true));",
      fn: (d: { employees: { active: boolean }[] }) => d.employees.every((e) => e.active === true),
      options: { paramNames: ["d"] },
    },
    {
      name: "flattened ternary case",
      source: 'users.where((u) => (u.age < 18 ? "minor" : u.age < 65 ? "adult" : "senior"));',
      fn: (u: { age: number }) => (u.age < 18 ? "minor" : u.age < 65 ? "adult" : "senior"),
    },
    {
      name: "distinct aggregate",
      source: "users.where((u) => count(distinct(u.category)) > 1);",
      fn: Object.assign(() => false, {
        toString: () => "(u) => count(distinct(u.category)) > 1",
      }),
    },
    {
      name: "separator-bearing aggregate",
      source: 'users.where((u) => groupConcat(u.name, ", ") === "A, B");',
      fn: Object.assign(() => false, {
        toString: () => '(u) => groupConcat(u.name, ", ") === "A, B"',
      }),
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

  it("produces identical select IR for a separator-bearing aggregate", () => {
    const source = 'users.select((u) => ({ names: groupConcat(u.name, ", ") }));';
    const fn = Object.assign(() => ({}), {
      toString: () => '(u) => ({ names: groupConcat(u.name, ", ") })',
    });

    const transformerIr = transformSelectToIr(source);
    expect(parseArrowToIrSelect(fn)).toEqual(
      transformerIr ? { ...transformerIr, aliases: transformerIr.aliases ?? [] } : null,
    );
  });

  it("leaves declared relation projections for canonical runtime relation parsing", () => {
    const source =
      "users.select((u) => ({ posts: u.posts.query().select((p) => ({ id: p.id })) }));";
    const transformed = transformSource(source);
    const statement = transformed.statements[0];
    expect(statement && ts.isExpressionStatement(statement)).toBe(true);
    if (!statement || !ts.isExpressionStatement(statement)) return;
    expect(ts.isCallExpression(statement.expression)).toBe(true);
    if (!ts.isCallExpression(statement.expression)) return;
    expect(ts.isArrowFunction(statement.expression.arguments[0])).toBe(true);

    const fn = (u: any) => ({
      posts: u.posts.query().select((p: any) => ({ id: p.id })),
    });
    expect(parseArrowToIrSelect(fn)?.relations).toEqual([
      { name: "posts", outputKey: "posts", subPaths: [["id"]] },
    ]);
  });
});
