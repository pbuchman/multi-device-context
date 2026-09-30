import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["apps/web/src/test-setup.ts"],
    exclude: ["**/node_modules/**", "**/*.rules.test.ts", "scripts/runtime/**/*.test.mjs"],
  },
});
