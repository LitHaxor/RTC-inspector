import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/sdk/src/**/*.ts", "packages/extension/src/bridge.ts", "packages/extension/src/panel/poller.ts", "packages/extension/src/panel/tabs.ts", "packages/extension/src/readers.ts", "packages/extension/scripts/package.ts", "packages/extension/scripts/publish.ts"],
      exclude: ["**/index.ts", "**/types.ts"],
      thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 },
    },
  },
});
