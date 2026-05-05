/**
 * Default logger — `console`-backed at warn level and above. Keeps `info` /
 * `debug` quiet so the cache layer doesn't pollute production logs by default.
 *
 * Apps that want verbose tracing inject their own `Logger` via
 * `CacheHandlerOptions.logger`.
 */

import type { Logger } from "../types.js";

export const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message, meta) => {
    if (meta) console.warn(`[next-cache] ${message}`, meta);
    else console.warn(`[next-cache] ${message}`);
  },
  error: (message, meta) => {
    if (meta) console.error(`[next-cache] ${message}`, meta);
    else console.error(`[next-cache] ${message}`);
  },
};
