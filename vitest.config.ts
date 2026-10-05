import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["apps/web/src/test-setup.ts"],
    exclude: ["**/node_modules/**", ".local/**", "**/*.rules.test.ts", "scripts/runtime/**/*.test.mjs", "scripts/security/**/*.test.mjs", "scripts/operations/**/*.test.mjs", "apps/mobile/**/*.test.mjs"],
  },
});
