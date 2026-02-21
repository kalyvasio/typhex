import { describe, it, expect } from "vitest";
import {
  getColumnNames,
  normalizeCol,
  sqlType,
  type TableDefinition,
} from "../../src/schema/types.js";

describe("schema/types", () => {
  describe("getColumnNames", () => {
    it("returns keys of definition", () => {
      const def: TableDefinition = { id: "integer", name: "text", age: "integer" };
      expect(getColumnNames(def)).toEqual(["id", "name", "age"]);
    });
  });

  describe("normalizeCol", () => {
    it("converts string to ColumnDef with inferred flags", () => {
      const c = normalizeCol("integer primary key autoincrement");
      expect(c.type).toBe("integer primary key autoincrement");
      expect(c.primaryKey).toBe(true);
      expect(c.autoIncrement).toBe(true);
    });

    it("returns object as-is when already ColumnDef", () => {
      const def = { type: "text", nullable: false };
      expect(normalizeCol(def)).toBe(def);
    });
  });

  describe("sqlType", () => {
    it("returns type string for simple column", () => {
      const def: TableDefinition = { id: "integer" };
      expect(sqlType(def, "id")).toContain("integer");
    });

    it("adds PRIMARY KEY when not in type string", () => {
      const def: TableDefinition = { id: { type: "integer", primaryKey: true } };
      expect(sqlType(def, "id")).toContain("PRIMARY KEY");
    });

    it("adds AUTOINCREMENT when not in type string", () => {
      const def: TableDefinition = { id: { type: "integer", autoIncrement: true } };
      expect(sqlType(def, "id")).toContain("AUTOINCREMENT");
    });

    it("adds NOT NULL when nullable is false", () => {
      const def: TableDefinition = { name: { type: "text", nullable: false } };
      expect(sqlType(def, "name")).toContain("NOT NULL");
    });

    it("adds DEFAULT for number and string", () => {
      const defNum: TableDefinition = { n: { type: "integer", default: 0 } };
      expect(sqlType(defNum, "n")).toContain("DEFAULT 0");
      const defStr: TableDefinition = { s: { type: "text", default: "x" } };
      expect(sqlType(defStr, "s")).toContain("DEFAULT 'x'");
    });
  });
});
