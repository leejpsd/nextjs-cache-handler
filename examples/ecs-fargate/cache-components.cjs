/**
 * Wrapper for `cacheHandlers.default` (the `'use cache'` directive).
 * See `next.config.ts` in this directory.
 */
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createCacheComponentsHandler } = require("@leejpsd/nextjs-cache-handler/cache-components");

module.exports = createCacheComponentsHandler({
  client: {
    type: "redis",
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },
  // Auto-isolate every deploy. The Dockerfile pipes the git SHA into
  // DEPLOYMENT_VERSION at runtime so two deploys never read each other's
  // entries.
  buildNamespace: () =>
    process.env.DEPLOYMENT_VERSION || process.env.GIT_HASH || "unversioned",
  abortTimeoutMs: 1500,
  staleWhileRevalidate: true,
});
