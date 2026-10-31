import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CLI tests spawn real processes; give them room on slow CI machines.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // cli.ts runs in a child process in test/cli.test.ts, where coverage cannot see it.
      exclude: ["src/cli.ts", "src/types.ts"],
      reporter: ["text-summary", "text"],
      // Floors, not goals: CI fails if coverage drops below what the suite reaches today.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
