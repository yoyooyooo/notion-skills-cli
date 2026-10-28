import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/core/test/*.node.test.ts",
      "packages/proof-converter/test/*.node.test.ts",
      "packages/portable-converter/test/*.node.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
