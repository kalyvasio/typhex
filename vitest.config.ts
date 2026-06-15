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
      exclude: ["src/**/*.d.ts", "src/**/index.ts", "dist", "node_modules"],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 88,
        statements: 88,
      },
    },
  },
  resolve: {
    extensions: [".ts"],
  },
});
