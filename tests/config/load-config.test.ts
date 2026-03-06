import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";

describe("config/load-config", () => {
  it("loadConfig returns defaults when no config found", async () => {
    const config = await loadConfig({ cwd: "/nonexistent" });
    expect(config.dialect).toBe("sqlite");
    expect(config.migrationsFolder).toBe("./migrations");
  });

  it("loadConfig merges overrides", async () => {
    const config = await loadConfig({
      cwd: "/tmp",
      overrides: { dialect: "postgres", database: "mydb" },
    });
    expect(config.dialect).toBe("postgres");
    expect(config.database).toBe("mydb");
  });
});
