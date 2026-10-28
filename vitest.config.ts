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
    // These integration tests exercise native fsync and macOS Trash round trips.
    testTimeout: process.platform === "darwin" ? 60_000 : 30_000,
  },
})
