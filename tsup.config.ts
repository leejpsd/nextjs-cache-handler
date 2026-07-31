import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cache-components/index": "src/cache-components/index.ts",
    "incremental/index": "src/incremental/index.ts",
    "shared/client/adapter-redis": "src/shared/client/adapter-redis.ts",
    "shared/client/adapter-ioredis": "src/shared/client/adapter-ioredis.ts",
    "ops/index": "src/ops/index.ts",
    "otel/index": "src/otel/index.ts",
  },
  format: ["esm", "cjs"],
  // Inject createRequire-based shims so the runtime `require()` calls in the
  // client/OTel factories work from the ESM build too (without this, esbuild
  // emits a __require fallback that throws "Dynamic require of X is not
  // supported" in pure-ESM consumers).
  shims: true,
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
