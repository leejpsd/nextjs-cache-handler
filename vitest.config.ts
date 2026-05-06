import { defineConfig } from "vitest/config";

export default defineConfig({
  // Load .lua files as raw text (mirrors tsup's loader: { '.lua': 'text' }).
  // Without this, vitest's import analysis tries to parse the Lua source as JS.
  assetsInclude: ["**/*.lua"],
  plugins: [
    {
      name: "lua-as-string",
      transform(code: string, id: string) {
        if (id.endsWith(".lua")) {
          return {
            code: `export default ${JSON.stringify(code)};`,
            map: null,
          };
        }
        return null;
      },
    },
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
      reporter: ["text", "html", "lcov"],
      // Thresholds intentionally absent at v0.1. Integration tests that
      // exercise client adapters and the connection-manager fallback path
      // ship in v0.2 (with docker redis services), and only then can the
      // branch coverage realistically clear 85%. Re-enable once those tests
      // are in place.
    },
  },
});
