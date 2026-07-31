// Public API types. Exported from `@leejpsd/nextjs-cache-handler`.

/**
 * Minimal Redis client surface used by both handlers. Adapters in
 * `src/shared/client/` translate redis@5 / ioredis / Cluster to this shape.
 *
 * Methods follow `redis@5` (camelCase) naming. The ioredis adapter normalizes
 * snake_case calls into this contract.
 */
export interface RedisClientLike {
  isOpen: boolean;
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  del(keys: string | string[]): Promise<number>;
  sAdd(key: string, member: string | string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number | boolean>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  eval(
    script: string,
    opts: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
  evalSha?(
    sha: string,
    opts: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
  scriptLoad?(script: string): Promise<string>;
  scanIterator(opts: {
    MATCH: string;
    COUNT?: number;
  }): AsyncIterable<string[] | string>;
  ping(): Promise<string>;
  on(event: "error", listener: (err: Error) => void): unknown;
  /**
   * Close the underlying connection without waiting for pending replies.
   * Called by the connection manager when a dead client is replaced. Optional:
   * raw `redis@5` clients expose `destroy` and ioredis exposes `disconnect`,
   * both of which are used as fallbacks when this is absent.
   */
  dispose?(): void;
}

export type RedisClientFactory = () =>
  | RedisClientLike
  | Promise<RedisClientLike>;

export type RedisClientConfig =
  | {
      type: "redis";
      url: string;
      password?: string;
      tls?: boolean;
      connectTimeout?: number;
    }
  | {
      type: "ioredis";
      url: string;
      password?: string;
      tls?: boolean;
      connectTimeout?: number;
    }
  | {
      type: "cluster";
      nodes: Array<{ host: string; port: number }>;
      password?: string;
      tls?: boolean;
    };

/**
 * Fallback strategy when Redis is unavailable.
 *
 * - `auto` (default): try Redis; on connection failure or timeout, transparently
 *   fall back to an in-memory store. Multi-instance correctness is degraded but
 *   the app stays up.
 * - `always`: never connect to Redis. Useful for `next build` or local
 *   development. Equivalent to legacy `CACHE_HANDLER_FALLBACK=memory` env.
 * - `never`: connection failures are surfaced as cache misses. No memory fallback.
 */
export type FallbackStrategy = "auto" | "always" | "never";

/**
 * Telemetry hook. Called from inside the handlers on every meaningful event.
 * Optional — when not provided, only the process-local counters in
 * `src/shared/metrics.ts` are updated.
 */
export type MetricEventType =
  | "cache.hit"
  | "cache.miss"
  | "cache.get.deduped"
  | "cache.stale"
  | "cache.stale.refresh.leader"
  | "cache.stale.refresh.follower"
  | "cache.stale.refresh.skipped"
  | "cache.set"
  | "cache.set.failed"
  | "tag.invalidate.soft"
  | "tag.invalidate.hard"
  | "tag.expiration.read"
  | "redis.connect.failed"
  | "redis.timeout"
  | "fallback.activated"
  | "build_phase.skip";

export interface MetricEvent {
  type: MetricEventType;
  /** Operation latency in milliseconds, when measurable. */
  ms?: number;
  /** Free-form tags. Keep cardinality low (no user IDs, no cache keys). */
  meta?: Record<string, string | number | boolean>;
}

export type MetricEmitter = (event: MetricEvent) => void;

/**
 * Logger interface, compatible with `console`. Levels follow standard severity.
 */
export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Options shared by both `createCacheComponentsHandler` and
 * `createIncrementalCacheHandler`.
 */
export interface CacheHandlerOptions {
  /**
   * Redis client. Either:
   *  - a factory function returning a connected (or connectable) `RedisClientLike`
   *  - a config object describing how to construct one (lazy)
   */
  client: RedisClientFactory | RedisClientConfig;

  /**
   * Key prefix for namespace isolation. Defaults differ per handler:
   *  - cacheHandlers: `next-cache:`
   *  - incremental:   `next-incremental:`
   *
   * Useful when multiple Next.js apps share one Redis.
   */
  keyPrefix?: string;

  /**
   * Deployment-isolation namespace. Combined with `keyPrefix` so entries from
   * different deployments never collide.
   *
   * Resolution order if not provided:
   *   process.env.DEPLOYMENT_VERSION
   *   ?? process.env.GIT_HASH
   *   ?? "unversioned"
   *
   * Pass a function to defer reading process.env until first use (useful when
   * env is set after module load).
   */
  buildNamespace?: string | (() => string);

  /**
   * Per-operation timeout in milliseconds. Wraps every Redis call in an
   * AbortController. Default: 1500ms (matches the validated `pingRedis` value
   * from the reference implementation).
   *
   * On timeout:
   *  - `get` / `getExpiration` → cache miss (graceful)
   *  - `set` / `refreshTags`   → ignored (best-effort)
   *  - `updateTags` (hard expire) → propagated (revalidation must not be silent)
   */
  abortTimeoutMs?: number;

  /** Fallback strategy. See {@link FallbackStrategy}. */
  fallback?: FallbackStrategy;

  /**
   * Maximum number of entries kept by the in-memory fallback store (and the
   * same cap for its tag-set index). Least-recently-used entries are evicted
   * beyond the cap, so a long Redis outage on a busy site degrades to partial
   * caching instead of unbounded process memory growth. Default: 1000.
   */
  memoryMaxEntries?: number;

  /**
   * Whether to keep returning a stale entry in the SWR window
   * (`revalidate < age < expire`) while Next.js triggers a background refresh.
   *
   * Default: `true`. Set to `false` to revert to "expire on revalidate" behavior.
   */
  staleWhileRevalidate?: boolean;

  /**
   * Single-flight refresh lock for the SWR boundary.
   *
   * When enabled, only one handler instance per cache key attempts a
   * background refresh during the stale window. Other instances continue
   * serving the same stale entry until the leader publishes a fresh one or
   * the lock TTL expires. Prevents N parallel refreshes (cache stampede)
   * when many instances cross the `revalidate` boundary at the same time.
   *
   * Default: `false`. The marginal benefit at small scale is small because
   * Next.js already serializes per-cacheKey refresh per process; turn this
   * on when you have many instances and observe duplicate origin work
   * around the revalidate boundary.
   */
  singleFlight?: boolean;

  /**
   * Lock TTL in seconds for `singleFlight` mode. Default: 10.
   *
   * Long enough that a normal refresh can complete (most are sub-second),
   * short enough that a crashed leader doesn't block followers for long.
   */
  singleFlightLockTtlSec?: number;

  /**
   * Override the build-phase detector. Default checks
   * `process.env.NEXT_PHASE === "phase-production-build"`.
   *
   * During build phase, all Redis calls are skipped and the in-memory fallback
   * is used. Prevents PR #207-style ECONNREFUSED at build time.
   */
  isBuildPhase?: () => boolean;

  /** Metrics emitter. */
  onMetric?: MetricEmitter;

  /** Custom logger. Defaults to a `console` adapter (warn level and above). */
  logger?: Logger;

  /**
   * Use Redis Cluster hash tags in keys (`next-cache:{ns}:entry:...`). Required
   * when running against a cluster so multi-key Lua scripts land on the same
   * slot. Default: `false`.
   */
  hashTag?: boolean;
}

/**
 * Cache entry shape used by `cacheHandlers` (the `'use cache'` interface).
 * Mirrors Next.js 16's internal CacheEntry type.
 */
export interface CacheComponentsEntry {
  /** Rendered RSC payload. Streamed during write, materialized to base64 in storage. */
  value: ReadableStream<Uint8Array>;
  tags: string[];
  /** SWR window start (seconds). */
  stale: number;
  /** Creation time (ms since epoch). */
  timestamp: number;
  /** Hard expiration (seconds since timestamp). */
  expire: number;
  /** Background refresh trigger time (seconds since timestamp). */
  revalidate: number;
}

/**
 * Cache data shape used by the legacy `cacheHandler` (singular) interface for
 * ISR / route handlers. Value is a fully materialized buffer, not a stream.
 */
export interface IncrementalCacheData {
  value: Buffer | string | { kind: string; [key: string]: unknown } | null;
  lastModified?: number;
  tags?: string[];
}

/** Re-export the timeout error so callers can `instanceof`-check it. */
export { CacheTimeoutError } from "./shared/abort.js";
