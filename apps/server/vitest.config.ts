import { defineConfig } from "vitest/config"

// Database suites share cluster-wide roles, so test files run one after the other.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"], fileParallelism: false, testTimeout: 20_000, hookTimeout: 60_000 },
})
