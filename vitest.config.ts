import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@arbor/db": path.resolve("./packages/db/src/index.ts"),
      "@arbor/mcp-url-fetcher": path.resolve("./packages/mcp-url-fetcher/src/index.ts"),
    },
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
