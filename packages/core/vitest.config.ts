import { defineConfig } from "vitest/config"

// Some rule tests read the XML the rules build with DOMParser, so tests run in
// jsdom. The rule code itself is checked without DOM types (tsconfig.json).
export default defineConfig({
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
})
