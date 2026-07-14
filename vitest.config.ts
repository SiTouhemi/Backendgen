import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Generated projects carry their own Jest suites. They are run by
    // `backendgen test-generated` inside the generated project, never by the
    // compiler's own Vitest run.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "generated/**",
      "benchmark/runs/**",
      "**/.backendgen/**",
    ],
    testTimeout: 30_000,
  },
});
