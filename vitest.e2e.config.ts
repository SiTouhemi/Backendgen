import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
    pool: "forks",
    maxWorkers: 1,
  },
});
