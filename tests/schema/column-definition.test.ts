import { describe, expect, it } from "vitest";
import { parseColumnDefinition } from "../../src/schema/column-definition.js";

describe("parseColumnDefinition", () => {
  it("parses supported constraint metadata", () => {
    expect(parseColumnDefinition("integer primary key not null autoincrement default 1")).toEqual({
      primaryKey: true,
      notNull: true,
      autoIncrement: true,
      hasDefault: true,
      defaultValue: "1",
    });
  });

  it("supports alternate auto-increment spelling", () => {
    expect(parseColumnDefinition("integer auto_increment").autoIncrement).toBe(true);
  });

  it("extracts default values", () => {
    expect(parseColumnDefinition("text default 'anon' not null").defaultValue).toBe("'anon'");
    expect(parseColumnDefinition("timestamp default (datetime('now'))").defaultValue).toBe(
      "(datetime('now'))",
    );
  });

  it("reports definitions without defaults", () => {
    expect(parseColumnDefinition("text")).toEqual({
      primaryKey: false,
      notNull: false,
      autoIncrement: false,
      hasDefault: false,
      defaultValue: null,
    });
  });
});
