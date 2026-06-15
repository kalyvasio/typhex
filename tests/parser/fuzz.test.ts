import { describe, expect, it } from "vitest";
import { parseArrowToIr } from "../../src/parser/parse-arrow.js";
import type { IrNode } from "../../src/ir/types.js";
import type { BaseQueryCompiler } from "../../src/dbs/query-compiler.js";
import {
  compileIrWhere,
  postgresQueryCompiler,
  sqliteQueryCompiler,
} from "../ir/compile-ir-helpers.js";

type PredicateRow = {
  id: number;
  age: number;
  score: number;
  flags: number;
  name: string;
  country: string;
  active: boolean;
  deletedAt: string | null;
};

type PredicateFn = (u: PredicateRow) => boolean;

const baseExpressions: string[] = [
  "u.age > 18",
  "u.age >= 0",
  "u.score <= 100",
  "u.country === 'US'",
  "u.country !== 'GR'",
  "u.deletedAt === null",
  "u.deletedAt !== null",
  "u.name.startsWith('A')",
  "u.name.endsWith('son')",
  "u.name.includes('ann')",
  "u.id in [1, 2, 3]",
  "!(u.id in [4, 5, 6])",
  "(u.flags & 4) !== 0",
  "(u.flags | 2) > 0",
  "(u.age + 5) > u.score",
  "(u.score - u.age) >= 10",
  "(u.active ? u.score : 0) >= 10",
];

const compilers: BaseQueryCompiler[] = [sqliteQueryCompiler, postgresQueryCompiler];

function predicateFromSource(expression: string): PredicateFn {
  return new Function(`return (u) => ${expression};`)() as PredicateFn;
}

function combinedExpressions(): string[] {
  const expressions: string[] = [...baseExpressions];

  for (let i = 0; i < baseExpressions.length; i++) {
    const left = baseExpressions[i];
    const right = baseExpressions[(i + 3) % baseExpressions.length];
    expressions.push(`(${left}) && (${right})`);
    expressions.push(`(${left}) || (${right})`);
  }

  return expressions;
}

describe("parser/compiler fuzz coverage", () => {
  it("parses and compiles generated supported predicates for SQLite and PostgreSQL", () => {
    for (const expression of combinedExpressions()) {
      const ir: IrNode = parseArrowToIr(predicateFromSource(expression));

      for (const compiler of compilers) {
        const compiled = compileIrWhere(ir, compiler);

        expect(compiled.sql, expression).toBeTruthy();
        expect(compiled.sql, expression).not.toContain("undefined");
        expect(compiled.params, expression).toBeInstanceOf(Array);
      }
    }
  });
});
