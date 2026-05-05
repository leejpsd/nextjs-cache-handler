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
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
