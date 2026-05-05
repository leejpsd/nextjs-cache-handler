/**
 * `cacheHandlers` (plural) entry point — for the `'use cache'` directive.
 *
 * Use this from a wrapper module referenced by `next.config.ts`:
 *
 *   // cache.config.ts
 *   import { createCacheComponentsHandler } from "@leejpsd/nextjs-cache-handler/cache-components";
 *   module.exports = createCacheComponentsHandler({
 *     client: { type: "redis", url: process.env.REDIS_URL! },
 *     buildNamespace: process.env.DEPLOYMENT_VERSION,
 *   });
 *
 *   // next.config.ts
 *   const nextConfig = {
 *     cacheComponents: true,
 *     cacheHandlers: {
 *       default: require.resolve("./cache.config.ts"),
 *     },
 *   };
 */

export {
  createCacheComponentsHandler,
  type CacheComponentsHandler,
} from "./handler.js";
export { partitionEntry, shouldServeStale } from "./swr.js";
