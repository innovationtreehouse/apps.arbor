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
    include: ["packages/*/src/**/*.integration.test.ts"],
    environment: "node",
  },
});
