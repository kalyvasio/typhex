import { describe, it, expect } from "vitest";
import { parseFkDependencies, topoSort } from "../../src/migration/topo-sort.js";

describe("parseFkDependencies", () => {
  it("extracts references from column definitions", () => {
    const entities = [
      {
        table: {
          _table: "posts",
          _schema: { id: "integer primary key", user_id: "integer references users(id)" },
        },
      },
      { table: { _table: "users", _schema: { id: "integer primary key", name: "text" } } },
    ];
    const deps = parseFkDependencies(entities);
    expect(deps.get("posts")).toEqual(["users"]);
    expect(deps.get("users")).toEqual([]);
  });

  it("ignores self-references", () => {
    const entities = [
      {
        table: {
          _table: "nodes",
          _schema: { id: "integer primary key", parent_id: "integer references nodes(id)" },
        },
      },
    ];
    const deps = parseFkDependencies(entities);
    expect(deps.get("nodes")).toEqual([]);
  });

  it("handles quoted table names", () => {
    const entities = [
      {
        table: {
          _table: "comments",
          _schema: { id: "integer primary key", post_id: 'integer references "posts"(id)' },
        },
      },
    ];
    const deps = parseFkDependencies(entities);
    expect(deps.get("comments")).toEqual(["posts"]);
  });

  it("returns empty deps for tables with no FKs", () => {
    const entities = [
      { table: { _table: "tags", _schema: { id: "integer primary key", name: "text not null" } } },
    ];
    const deps = parseFkDependencies(entities);
    expect(deps.get("tags")).toEqual([]);
  });
});

describe("topoSort", () => {
  it("orders independent tables in original order", () => {
    const deps = new Map([
      ["a", []],
      ["b", []],
      ["c", []],
    ]);
    expect(topoSort(["a", "b", "c"], deps)).toEqual(["a", "b", "c"]);
  });

  it("puts dependencies before dependents", () => {
    const deps = new Map([
      ["posts", ["users"]],
      ["users", []],
      ["comments", ["posts"]],
    ]);
    const sorted = topoSort(["comments", "posts", "users"], deps);
    expect(sorted.indexOf("users")).toBeLessThan(sorted.indexOf("posts"));
    expect(sorted.indexOf("posts")).toBeLessThan(sorted.indexOf("comments"));
  });

  it("handles diamond dependencies", () => {
    const deps = new Map([
      ["d", ["b", "c"]],
      ["b", ["a"]],
      ["c", ["a"]],
      ["a", []],
    ]);
    const sorted = topoSort(["d", "b", "c", "a"], deps);
    expect(sorted.indexOf("a")).toBeLessThan(sorted.indexOf("b"));
    expect(sorted.indexOf("a")).toBeLessThan(sorted.indexOf("c"));
    expect(sorted.indexOf("b")).toBeLessThan(sorted.indexOf("d"));
    expect(sorted.indexOf("c")).toBeLessThan(sorted.indexOf("d"));
  });

  it("throws on circular dependency", () => {
    const deps = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(() => topoSort(["a", "b"], deps)).toThrow("Circular FK dependency");
  });

  it("ignores deps on tables not in the input set", () => {
    const deps = new Map([["posts", ["users"]]]);
    expect(topoSort(["posts"], deps)).toEqual(["posts"]);
  });
});
