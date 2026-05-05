/**
 * @leejpsd/nextjs-cache-handler — main barrel.
 *
 * Most consumers should import from the dedicated subpath that matches the
 * Next.js option they're configuring:
 *
 *   import { createCacheComponentsHandler } from "@leejpsd/nextjs-cache-handler/cache-components";
 *   import { createIncrementalCacheHandler } from "@leejpsd/nextjs-cache-handler/incremental";
 *
 * The root barrel exists so a single `import { ... } from "@leejpsd/nextjs-cache-handler"`
 * works for code that wires up both handlers.
 */

export {
  createCacheComponentsHandler,
  type CacheComponentsHandler,
  partitionEntry,
  shouldServeStale,
} from "./cache-components/index.js";

export {
  createIncrementalCacheHandler,
  IncrementalRedisCacheHandler,
  type IncrementalCtx,
} from "./incremental/index.js";

export { CacheTimeoutError } from "./shared/abort.js";
export { isBuildPhase, shouldUseRedis } from "./shared/build-phase.js";
export { resolveBuildNamespace } from "./shared/namespace.js";
export { getMetricSnapshot } from "./shared/metrics.js";

export type {
  CacheHandlerOptions,
  CacheComponentsEntry,
  IncrementalCacheData,
  RedisClientLike,
  RedisClientConfig,
  RedisClientFactory,
  FallbackStrategy,
  MetricEvent,
  MetricEventType,
  MetricEmitter,
  Logger,
} from "./types.js";
