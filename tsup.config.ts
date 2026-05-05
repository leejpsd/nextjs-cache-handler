import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cache-components/index": "src/cache-components/index.ts",
    "incremental/index": "src/incremental/index.ts",
    "shared/client/adapter-redis": "src/shared/client/adapter-redis.ts",
    "shared/client/adapter-ioredis": "src/shared/client/adapter-ioredis.ts",
    "ops/index": "src/ops/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ["redis", "ioredis", "next"],
  loader: {
    ".lua": "text",
  },
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
});
