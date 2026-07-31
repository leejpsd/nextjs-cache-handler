import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// Redis Cluster e2e suite. Requires a local 3-master cluster:
//   scripts/cluster-test-env.sh up
// Run with: npm run test:cluster
export default defineConfig({
  plugins: [
    {
      name: "lua-as-string",
      enforce: "pre",
      load(id: string) {
        if (id.endsWith(".lua")) {
          const body = readFileSync(id, "utf8");
          return `export default ${JSON.stringify(body)};`;
        }
        return null;
      },
    },
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/cluster/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    fileParallelism: false,
  },
});
