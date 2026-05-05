/**
 * `cacheHandler` (singular) entry point — for Pages Router ISR and on-demand
 * revalidation. See docs/next16-spec.md §3.
 *
 * Usage:
 *
 *   // cache-incremental.config.ts
 *   import { createIncrementalCacheHandler } from "@leejpsd/nextjs-cache-handler/incremental";
 *   module.exports = createIncrementalCacheHandler({
 *     client: { type: "redis", url: process.env.REDIS_URL! },
 *     buildNamespace: process.env.DEPLOYMENT_VERSION,
 *   });
 *
 *   // next.config.ts
 *   const nextConfig = {
 *     cacheHandler: require.resolve("./cache-incremental.config.ts"),
 *     cacheMaxMemorySize: 0, // delegate entirely to this handler
 *   };
 */

export {
  createIncrementalCacheHandler,
  IncrementalRedisCacheHandler,
} from "./handler.js";
export type { IncrementalCtx } from "./handler.js";
