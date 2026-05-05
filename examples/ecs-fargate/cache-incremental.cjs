/**
 * Wrapper for `cacheHandler` (singular) — Pages Router ISR + on-demand
 * revalidation + APP_PAGE/APP_ROUTE/FETCH/IMAGE entry kinds.
 */
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createIncrementalCacheHandler } = require("@leejpsd/nextjs-cache-handler/incremental");

module.exports = createIncrementalCacheHandler({
  client: {
    type: "redis",
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },
  buildNamespace: () =>
    process.env.DEPLOYMENT_VERSION || process.env.GIT_HASH || "unversioned",
  abortTimeoutMs: 1500,
});
