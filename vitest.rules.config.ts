import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["infra/**/*.rules.test.ts", "apps/server/src/**/*.rules.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
});
