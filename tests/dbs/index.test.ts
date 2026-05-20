import { describe, it, expect } from "vitest";
import type { DialectName } from "../../src/dbs/types.js";
import { getDialect, getColumnDef, sqliteDialect, postgresDialect } from "../../src/dbs/index.js";

describe("dbs/index", () => {
  describe("getDialect", () => {
    it("returns sqlite dialect for sqlite", () => {
      const d = getDialect("sqlite");
      expect(d.name).toBe("sqlite");
      expect(d).toBe(sqliteDialect);
    });

    it("returns postgres dialect for postgres", () => {
      const d = getDialect("postgres");
      expect(d.name).toBe("postgres");
      expect(d).toBe(postgresDialect);
    });

    it("throws for unknown dialect", () => {
      expect(() => getDialect("mysql" as DialectName)).toThrow("Unknown dialect");
    });

    it("exposes queryCompiler on dialect", () => {
      expect(getDialect("sqlite").queryCompiler).toBe(sqliteDialect.queryCompiler);
      expect(getDialect("postgres").queryCompiler).toBe(postgresDialect.queryCompiler);
    });

    it("exposes migrator on dialect", () => {
      expect(getDialect("sqlite").migrator).toBe(sqliteDialect.migrator);
      expect(getDialect("postgres").migrator).toBe(postgresDialect.migrator);
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
