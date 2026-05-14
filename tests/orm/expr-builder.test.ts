import { describe, expect, it } from "vitest";
import type { IrNode } from "../../src/ir/types.js";
import { ExprBuilder } from "../../src/orm/helpers/query-plan/expr-builder.js";

describe("ExprBuilder", () => {
  it("throws a clear error when EXISTS metadata is missing", () => {
    const exists: IrNode = {
      kind: "exists",
      rootParam: "u",
      relationKey: "posts",
      innerParam: "p",
      innerWhere: { kind: "const", value: true },
    };
    const builder = new ExprBuilder({ u: "t0" }, {}, {}, new Map(), new Set(["posts"]));

    expect(() => builder.convert(exists)).toThrow(
      '[typhex] EXISTS predicate for relation "posts" could not be planned',
    );
  });
});
