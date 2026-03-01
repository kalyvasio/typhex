import { describe, it, expect } from "vitest";
import { getDialect, getDbMigrations, getColumnDef } from "../../src/dbs/index.js";

describe("dbs/index", () => {
  describe("getDialect", () => {
    it("returns sqlite dialect for sqlite", () => {
      const d = getDialect("sqlite");
      expect(d.name).toBe("sqlite");
    });

    it("returns postgres dialect for postgres", () => {
      const d = getDialect("postgres");
      expect(d.name).toBe("postgres");
    });

    it("throws for unknown dialect", () => {
      expect(() => getDialect("mysql")).toThrow("Unknown dialect");
    });
  });

  describe("getDbMigrations", () => {
    it("returns sqlite migrations for sqlite", () => {
      const m = getDbMigrations("sqlite");
      expect(m.dialect).toBe("sqlite");
      expect(m.generateSql).toBeDefined();
      expect(m.getTrackingTableDdl).toBeDefined();
    });

    it("returns postgres migrations for postgres", () => {
      const m = getDbMigrations("postgres");
      expect(m.dialect).toBe("postgres");
      expect(m.generateSql).toBeDefined();
      expect(m.getTrackingTableDdl).toBeDefined();
    });

    it("throws for unknown dialect", () => {
      expect(() => getDbMigrations("mysql")).toThrow("Unknown dialect");
    });
  });

  describe("getColumnDef", () => {
    it("returns string def as-is", () => {
      expect(getColumnDef("integer primary key", "sqlite")).toBe("integer primary key");
    });

    it("returns dialect-specific def from object", () => {
      const def = { sqlite: "integer", postgres: "SERIAL" };
      expect(getColumnDef(def, "sqlite")).toBe("integer");
      expect(getColumnDef(def, "postgres")).toBe("SERIAL");
    });

    it("falls back to sqlite then postgres when dialect missing", () => {
      const def = { sqlite: "text" };
      expect(getColumnDef(def, "postgres")).toBe("text");
    });
  });
});
