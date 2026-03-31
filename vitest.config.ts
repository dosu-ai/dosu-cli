import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      exclude: [
        "**/index.ts", // barrel re-export files
        "src/index.ts", // CLI entry point
        "scripts/*", // build scripts (spawn Bun)
        "vitest.config.ts", // config file
        "release.config.js", // semantic-release config
      ],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 80,
        lines: 95,
      },
    },
  },
});
