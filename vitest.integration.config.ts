import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve every workspace package to its source so tests never need dist.
    alias: [{ find: /^@arbor\/(.+)$/, replacement: path.resolve("./packages/$1/src/index.ts") }],
  },
  test: {
    include: ["packages/*/src/**/*.integration.test.ts"],
    environment: "node",
  },
});
