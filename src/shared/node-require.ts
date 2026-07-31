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
import path from "node:path";

const packageRequire = createRequire(import.meta.url);
const cwdRequire = createRequire(
  path.join(process.cwd(), "__resolve-anchor__.js")
);

export function nodeRequire(id: string): unknown {
  try {
    return packageRequire(id);
  } catch {
    // Symlinked installs (npm i <local-path>, pnpm's virtual store) resolve
    // import.meta.url to the package's REAL location, outside the app tree —
    // so peers installed by the app aren't reachable from that anchor. Retry
    // from the process CWD, which under a Next.js server is the app root.
    return cwdRequire(id);
  }
}
