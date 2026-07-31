/**
 * A require() that works from BOTH build outputs.
 *
 * The client/OTel factories load optional peers (`redis`, `ioredis`,
 * `@opentelemetry/api`) lazily at runtime. A bare `require()` compiles fine
 * for CJS but becomes esbuild's `__require` fallback in the ESM build, which
 * throws "Dynamic require of X is not supported" in pure-ESM consumers.
 * `createRequire(import.meta.url)` is real in ESM, and tsup's `shims: true`
 * provides an `import.meta.url` polyfill for the CJS build.
 */
import { createRequire } from "node:module";

export const nodeRequire: NodeJS.Require = createRequire(import.meta.url);
