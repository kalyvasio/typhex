import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/index.ts",
        "src/driver/sqlite.ts",
        "src/driver/types.ts",
        "src/transformer/**",
        "src/orm/db.ts",
        "dist",
        "node_modules",
      ],
      thresholds: {
        branches: 80,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
  resolve: {
    extensions: [".ts"],
  },
});
