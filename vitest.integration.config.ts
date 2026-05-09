import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// Separate vitest config for integration tests:
// - longer testTimeout (real Redis round-trips, ~50ms each)
// - integration tests don't run in parallel (they share one Redis instance)
//
// Note on the .lua loader: we use a `load` hook (not a `transform` hook)
// and we explicitly read the file from disk. Combining `assetsInclude` and
// a `transform` hook caused vite to apply two passes — the first turned the
// raw string into `export default "..."`, then the transform hook wrapped
// it AGAIN, so the runtime ended up with `export default "export default
// \"...\""`. The Lua server then rejected the `export default` prefix as
// invalid syntax, surfacing as
//   `ERR Error compiling script (new function): user_script:1:
//    '=' expected near 'default'`.
// A single `load` hook avoids the double wrap.
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
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    fileParallelism: false,
  },
});
