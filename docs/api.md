# API reference

Package: `@leejpsd/nextjs-cache-handler` — Redis cache handler for Next.js
15/16 shipping both handler interfaces. All entry points are dual-published
(ESM + CJS) with TypeScript types.

## Entry points

| Subpath | Exports | Use for |
|---|---|---|
| `@leejpsd/nextjs-cache-handler` | everything below + types | convenience root |
| `.../cache-components` | `createCacheComponentsHandler` | Next 16 `cacheHandlers` (plural) — `'use cache'`, `cacheComponents: true` |
| `.../incremental` | `createIncrementalCacheHandler` | `cacheHandler` (singular) — ISR, Pages Router, fetch cache. Next 15 and 16 |
| `.../client/redis` | `adaptRedisV5`, `createRedisV5Client` | wrap your own `redis@5` client |
| `.../client/ioredis` | `adaptIoredis`, `adaptCluster`, `createIoredisClient`, `createIoredisSentinel`, `createIoredisCluster` | wrap your own ioredis / Cluster / Sentinel client |
| `.../ops` | `getMetricSnapshot` | process-local metric counters for health endpoints |
| `.../otel` | `createOtelMetricEmitter` | built-in OpenTelemetry adapter (needs `@opentelemetry/api` in your app) |
| `.../seed` | `seedBuildOutput` | seed `.next` build output into Redis (NX-protected) — also `npx nextjs-cache-handler seed` |

## Factories

### `createCacheComponentsHandler(options: CacheHandlerOptions)`

Returns the object Next.js expects for `cacheHandlers.default` (methods:
`get`, `set`, `refreshTags`, `getExpiration`, `updateTags`). Requires
Next.js >= 16.1.5.

### `createIncrementalCacheHandler(options: CacheHandlerOptions)`

Returns a **class** for `cacheHandler` (Next.js instantiates it per request
with `new CacheHandler(ctx)`; methods: `get`, `set`, `revalidateTag`,
`resetRequestCache`). Works on Next.js 15 and 16 — both generations of the
ctx contract are accepted (`ctx.cacheControl.revalidate` / `kind` and
`ctx.revalidate` / `kindHint`).

## `CacheHandlerOptions`

| Option | Type | Default | Notes |
|---|---|---|---|
| `client` | `RedisClientFactory \| RedisClientConfig` | **required** | factory function or lazy config object |
| `keyPrefix` | `string` | `"next-cache:"` / `"next-incremental:"` | multi-app Redis sharing |
| `buildNamespace` | `string \| () => string` | `DEPLOYMENT_VERSION ?? GIT_HASH ?? NEXT_DEPLOYMENT_ID ?? "unversioned"` | per-deploy key isolation; function form defers env read |
| `abortTimeoutMs` | `number` | `1500` | per-operation deadline; timeout ⇒ miss (reads) / ignored (writes) / thrown (hard invalidation) |
| `fallback` | `"auto" \| "always" \| "never"` | `"auto"` | `always` = memory only (never connect); `never` = strict, Redis failures surface as misses |
| `memoryMaxEntries` | `number` | `1000` | LRU cap for the in-memory fallback (and its tag index) |
| `compression` | `"gzip" \| "brotli"` | off | transparent Redis value compression (node:zlib). Reads auto-detect, so mixed fleets interoperate; < 1 KiB stored plain |
| `staleWhileRevalidate` | `boolean` | `true` | plural handler only: serve stale in the SWR window |
| `singleFlight` | `boolean` | `false` | opt-in refresh lock at the SWR boundary (stampede suppression) |
| `singleFlightLockTtlSec` | `number` | `10` | lock TTL for `singleFlight` |
| `isBuildPhase` | `() => boolean` | `NEXT_PHASE === "phase-production-build"` | build-phase gate override |
| `hashTag` | `boolean` | `false` | wrap namespace in `{}` — **required on Redis Cluster** (multi-key Lua) |
| `tagPubSub` | `boolean` | `false` | push-based cross-instance tag propagation (plural handler; ~3ms); scan polling remains the safety net; unavailable on Cluster |
| `onMetric` | `(event: MetricEvent) => void` | — | telemetry hook; emitter errors are swallowed |
| `logger` | `Logger` | console (warn+) | injectable 4-level logger |

## `RedisClientConfig`

```ts
| { type: "redis";    url; password?; tls?; connectTimeout? }   // node-redis v5
| { type: "ioredis";  url; password?; tls?; connectTimeout? }
| { type: "cluster";  nodes: {host, port}[]; password?; tls? }  // ioredis Cluster — set hashTag: true
| { type: "sentinel"; sentinels: {host, port}[]; name;          // ioredis Sentinel — master discovery + failover
    password?; sentinelPassword?; tls?; connectTimeout? }
```

`tls: true` enables TLS explicitly; `rediss://` URLs auto-enable it on the
`redis` client type. All ioredis-family clients use lazy connect,
`maxRetriesPerRequest: 1`, and auto-pipelining.

Connection management: a failed connect is retried with exponential backoff
(1s base, doubling, capped at 30s); during the cooldown operations fast-fail
to the fallback path. Dropped connections are replaced automatically.

You can also pass a **factory** returning any object satisfying
`RedisClientLike` (see `src/types.ts`) — useful for Upstash/custom clients.

## Metric events (`MetricEventType`)

`cache.hit` · `cache.miss` · `cache.get.deduped` · `cache.stale` ·
`cache.stale.refresh.leader` · `cache.stale.refresh.follower` · `cache.set` ·
`cache.set.failed` · `tag.invalidate.soft` · `tag.invalidate.hard` ·
`tag.expiration.read` · `redis.connect.failed` · `redis.timeout` ·
`fallback.activated` · `build_phase.skip`

Events may carry `ms` (latency) and low-cardinality `meta` (`backend`,
`reason`, `op`, counts). Cache keys and tag names are never emitted.

### `getMetricSnapshot()` (`.../ops`)

Returns `{ [eventType]: { count, avgMs, lastTs } }` from always-on
process-local counters. Suitable for `/api/health`-style endpoints.

### `createOtelMetricEmitter(options?)` (`.../otel`)

Builds a `MetricEmitter` forwarding events to OpenTelemetry: counter
`nextjs_cache.events_total` + histogram `nextjs_cache.op_latency_ms`,
attributes limited to `type`, `freshness`, `backend`, `reason`, `op`.
Requires `@opentelemetry/api` installed in **your app** (it is an optional
peer, resolved at runtime). Options: `api` (inject the module — tests/custom
setups), `meterName`, `counterName`, `histogramName`.

## Behavioral notes

- **Key layout**: `"<keyPrefix><kind>:<namespace>:<rest>"`, e.g.
  `next-cache:entry:<deploy>:<key>`, `next-cache:tag:<deploy>:<tag>`,
  `next-cache:tag-expiration:<deploy>:<tag>`,
  `next-incremental:entry:<deploy>:<path>`. ISR tag state
  (`next-incremental:tag:<tag>`) is deliberately **not** namespaced so
  `revalidateTag` from a new deploy invalidates older deploys' entries.
- **Request-scoped dedup** (singular): repeated reads of one cache key within
  a request share a single Redis GET; `set()` invalidates the memo and
  `resetRequestCache()` clears it at request boundaries.
- **`instance-local:` tag prefix** (singular): entries tagged
  `instance-local:*` are stored in process memory only and never touch Redis.
- **Error policy**: reads never throw (degrade to miss); writes are
  best-effort; hard tag invalidation (`updateTags` with `expire: 0`, ISR
  `revalidateTag` hard path) propagates errors so callers can retry.
- **`CacheTimeoutError`** is exported from the root for `instanceof` checks.
