/**
 * Unit tests for the select transformer: source → transform → snapshot.
 */

import { describe, it, expect, vi } from "vitest";
import * as ts from "typescript";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
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

/** Real program build so the type checker can resolve static `tableName`
 *  on entity classes referenced from inline subqueries. */
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

/** Transform with real type resolution for scope-call inlining (method declaration lookup). */
function transformWithTypes(sourceText: string, extraFiles?: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "typhex-transformer-test-"));
  try {
    const extraPaths: string[] = [];
    for (const [filename, content] of Object.entries(extraFiles ?? {})) {
      const filePath = path.join(tmpDir, filename);
      fs.writeFileSync(filePath, content, "utf8");
      extraPaths.push(filePath);
    }

    const mainPath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(mainPath, sourceText, "utf8");

    const program = ts.createProgram([mainPath, ...extraPaths], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.CommonJS,
      strict: false,
      skipLibCheck: true,
      noEmit: true,
    });
    const sourceFile = program.getSourceFile(mainPath);
    if (!sourceFile) throw new Error("Could not get source file from program");

    const result = ts.transform(sourceFile, [createTyphexTransformer(program)]);
    return ts.createPrinter().printFile(result.transformed[0] as ts.SourceFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
      transform("users.select((u) => ({ userId: u.id, fullName: u.name, country: u.country }));"),
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
    expect(
      transform("products.select((p) => ({ category: p.category, total: sum(p.price) }));"),
    ).toMatchSnapshot();
  });

  it("transforms (p) => ({ cnt: count(p.id), maxSalary: max(p.salary) }) with multiple aggregates", () => {
    expect(
      transform("employees.select((p) => ({ cnt: count(p.id), maxSalary: max(p.salary) }));"),
    ).toMatchSnapshot();
  });

  it("transforms count(distinct(p.category)) single aggregate shorthand", () => {
    expect(transform("users.select((p) => count(distinct(p.category)));")).toMatchSnapshot();
  });

  it("transforms ({ unique: count(distinct(p.id)) }) object with distinct aggregate", () => {
    expect(
      transform("users.select((p) => ({ unique: count(distinct(p.id)) }));"),
    ).toMatchSnapshot();
  });

  it("transforms groupConcat(p.name, ', ') single aggregate shorthand", () => {
    expect(transform("users.select((p) => groupConcat(p.name, ', '));")).toMatchSnapshot();
  });

  it("transforms ({ names: groupConcat(p.name, ', ') }) object with groupConcat", () => {
    expect(
      transform("users.select((p) => ({ names: groupConcat(p.name, ', ') }));"),
    ).toMatchSnapshot();
  });

  it("transforms ({ id }) destructured outer with correlated inner subquery", () => {
    const source = `
class Post { static tableName: "posts" = "posts"; static query(): any { return null as any; } }
authors.select(({ id }: any) => ({ c: Post.query().where((p: any) => p.authorId === id).select(() => count()) }));
`;
    expect(transformWithChecker(source)).toMatchSnapshot();
  });

  it("transforms ({ id: authorId }) aliased destructured outer with correlated inner subquery", () => {
    const source = `
class Post { static tableName: "posts" = "posts"; static query(): any { return null as any; } }
authors.select(({ id: authorId }: any) => ({ c: Post.query().where((p: any) => p.authorId === authorId).select(() => count()) }));
`;
    expect(transformWithChecker(source)).toMatchSnapshot();
  });

  it("transforms inline subquery with .limit() chain segment", () => {
    const source = `
class Post { static tableName: "posts" = "posts"; static query(): any { return null as any; } }
authors.select((a: any) => ({ c: Post.query().where((p: any) => p.authorId === a.id).limit(10).select(() => count()) }));
`;
    expect(transformWithChecker(source)).toMatchSnapshot();
  });

  it("transforms inline subquery with .orderBy().limit() top-N chain", () => {
    const source = `
class Post { static tableName: "posts" = "posts"; static query(): any { return null as any; } }
authors.select((a: any) => ({ topScore: Post.query().where((p: any) => p.authorId === a.id).orderBy((p: any) => p.score, 'desc').limit(1).select((p: any) => max(p.score)) }));
`;
    expect(transformWithChecker(source)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Scope inlining tests: require real type resolution (transformWithTypes)
// ---------------------------------------------------------------------------

/** Stub QueryBuilder and entity classes for the scope-inlining tests.
 *  The transformer's isTyphexType() is mocked (always true) so the "receiver is
 *  a Typhex QB" check passes.  What we need here is for
 *  checker.getSymbolAtLocation(callee) to find the method declaration so
 *  extractWherePredicate can pull the inner where() call out of it. */
const STUB_DEFS = `
// Minimal stubs — no imports needed; isTyphexType is mocked to always return true.
declare class QueryBuilder<C, T> {
  where(predicate: (row: T) => boolean): this;
  select(fn: (row: T) => any): any;
}

interface CommentRow {
  id: number;
  postId: number;
  archived: number;
}

declare class CommentQuery extends QueryBuilder<any, CommentRow> {
  archived(): this {
    return this.where((c) => c.archived == 1);
  }
}

interface UserRow {
  id: number;
  name: string;
  comments: CommentQuery;
}

declare class UserQuery extends QueryBuilder<any, UserRow> {}

declare const users: UserQuery;
`;

describe("select transformer — scope inlining (real type resolution)", () => {
  it("inlines p.comments.archived() into an IrSelectRelation with whereIr", () => {
    // The CommentQuery.archived() scope calls this.where(c => c.archived == 1).
    // The transformer should resolve the method declaration and inline the
    // where predicate as a whereIr on the relation.
    const source = `
${STUB_DEFS}
users.select((p) => ({ comments: p.comments.archived() }));
`;
    const output = transformWithTypes(source);
    expect(output).toMatchSnapshot();
  });

  it("gracefully falls back (leaves call unchanged) when type resolution fails (noResolve program)", () => {
    // With noResolve: true the checker returns no symbol for the scope method,
    // so tryResolveScopeCall returns null and the entire select() call is left
    // unchanged (no IrSelect is emitted).
    const source = `users.select((p) => ({ comments: p.comments.archived() }));`;
    // Use the no-resolve transform helper — no type info available.
    const output = transform(source);
    // The call must NOT be transformed to an IR literal; it should be unchanged.
    expect(output).toContain("p.comments.archived()");
    expect(output).not.toContain("whereIr");
  });
});
