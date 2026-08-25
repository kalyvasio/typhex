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

  it("preserves quoted and expression defaults", () => {
    expect(parseColumnDefinition("text default 'primary key' not null").defaultValue).toBe(
      "'primary key'",
    );
    expect(
      parseColumnDefinition("timestamp default (datetime('now', '+1 day')) not null").defaultValue,
    ).toBe("(datetime('now', '+1 day'))");
  });

  it("ignores constraint keywords in quoted values and comments", () => {
    const metadata = parseColumnDefinition("text default 'not null' -- primary key autoincrement");
    expect(metadata.primaryKey).toBe(false);
    expect(metadata.notNull).toBe(false);
    expect(metadata.autoIncrement).toBe(false);
    expect(metadata.defaultValue).toBe("'not null'");
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
