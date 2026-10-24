import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve every workspace package to its source so tests never need dist.
    alias: [{ find: /^@arbor\/(.+)$/, replacement: path.resolve("./packages/$1/src/index.ts") }],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["packages/*/src/**/*.integration.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        // Runtime infrastructure — spawns external processes and HTTP servers,
        // not meaningful to unit-test in isolation.
        "packages/agent/src/gdrive-mcp-proxy.ts",
      ],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 90,
        branches: 80,
      },
    },
  },
});
