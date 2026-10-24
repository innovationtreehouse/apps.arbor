import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Pass files explicitly (`npm run lint -- <files>`); CI lints only changed files.
export default defineConfig(
  globalIgnores(["**/dist/", "coverage/"]),
  tseslint.configs.recommended,
  { files: ["**/__tests__/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
