# Architecture

## Two handlers, one infrastructure

Next.js 16 has two distinct cache handler interfaces (see
[`docs/next16-spec.md`](./next16-spec.md)). This package ships both, sharing
infrastructure but isolating per-handler state.

```
┌───────────────────────────────────────────────────────────────┐
│ Your app                                                      │
│   'use cache' fn ───► cacheHandlers.default ──┐               │
│   ISR / Pages Router / fetch tags ─► cacheHandler ──┐         │
└──────────────────────────────────────────────┼─────┼──────────┘
                                               ▼     ▼
              ┌──────────────────┐  ┌────────────────────────┐
              │ cache-components │  │ incremental            │
              │ /handler.ts      │  │ /handler.ts            │
              │  (5 methods)     │  │  (4 methods)           │
              └──────────────────┘  └────────────────────────┘
                       │                       │
                       └─────────┬─────────────┘
                                 ▼
              ┌────────────────────────────────────────┐
              │ shared/                                │
              │  build-phase.ts   abort.ts             │
              │  memory-fallback  namespace            │
              │  metrics  logger  client adapters      │
              │  lua/{set-with-tags, revalidate-hard}  │
              └────────────────────────────────────────┘
                                 │
                                 ▼
                         ┌──────────────┐
                         │ Redis client │   redis@5 / ioredis / Cluster
                         └──────────────┘
```

## Key prefixes

| Use | Prefix | Namespaced? | Why |
|---|---|---|---|
| `'use cache'` entry | `next-cache:entry:{ns}:{cacheKey}` | yes | Deploy isolation (a v1 entry is invisible to v2) |
| `'use cache'` tag set | `next-cache:tag:{ns}:{tag}` | yes | Tag membership scoped to deploy |
| `'use cache'` tag-expiration marker | `next-cache:tag-expiration:{ns}:{tag}` | yes | Cross-instance tag freshness sync |
| ISR entry | `next-incremental:entry:{ns}:{cacheKey}` | yes | Same reason — old prerender HTML can't bleed across deploys |
| ISR tag state | `next-incremental:tag:{tag}` | **no** | Intentional: `revalidateTag` from a new deploy must invalidate entries written by an old one |

`{ns}` is `process.env.DEPLOYMENT_VERSION || process.env.GIT_HASH || "unversioned"` —
see [`docs/build-phase.md`](./build-phase.md).

When running on Redis Cluster, set `hashTag: true` to wrap `{ns}` in `{}`,
forcing every multi-key Lua script to land on the same hash slot:
`next-cache:entry:{ns42}:cacheKey`.

## Read path (cacheHandlers.get)

```
get(cacheKey, softTags)
├── shouldUseRedis() — gate (build-phase, fallback policy)
├── withAbortSignal(1.5s) → client.get(entryKey)
│     │  Redis miss / timeout? → memory fallback
│     ▼
├── decodeEnvelope(raw) — JSON parse + base64
├── partitionEntry(entry) — 3-axis SWR (fresh / stale / expired)
│     │  expired or staleWhileRevalidate=false → MISS, evict, return undefined
│     ▼
├── soft-tag freshness check — localTagTimestamps vs entry.timestamp
│     │  any soft tag invalidated after entry? → MISS
│     ▼
├── bufferToStream(base64) → ReadableStream
└── return CacheEntry { value, tags, stale, timestamp, expire, revalidate }
```

## Write path (cacheHandlers.set)

```
set(cacheKey, pendingEntry: Promise<CacheEntry>)
├── await pendingEntry  (per spec — stream may still be writing)
├── readStreamFully(value) — Buffer materialization
│     │  partial-write error? → discard, emit cache.set.failed
│     ▼
├── encodeEnvelope(buf, meta) — JSON + base64
├── shouldUseRedis() — gate
│     │  build phase / no Redis? → memory fallback only
│     ▼
└── withAbortSignal(1.5s) → execLuaScript("setWithTags",
                                           [entryKey, ...tagKeys],
                                           [payload, ttl, ttl, tagCount])
     │  EVALSHA → on NOSCRIPT → SCRIPT LOAD → EVALSHA again
     ▼  (atomic SET + N×SADD + N×EXPIRE in one round trip)
   done.
```

## Tag invalidation

| Caller | `durations.expire` | Path |
|---|---|---|
| `revalidateTag(tag, profile)` | `undefined` | Soft. `SET tag-expiration:{ns}:{tag} <now>`; entries linger until natural revalidate |
| `updateTag(tag)` (Server Action) | `0` | Hard. Lua: `SMEMBERS tag → DEL entries → DEL tag → SET marker` atomically |
| `revalidatePath(path)` | `undefined` | Iterates the path's soft tags through soft path |

## Distributed coordination

For multi-instance deployments:

1. `updateTags()` writes a per-tag timestamp to Redis (the marker key).
2. `refreshTags()` is called before each request. It scans
   `next-cache:tag-expiration:{ns}:*` and updates `localTagTimestamps`.
3. `getExpiration([t1, t2])` returns `Math.max(timestamps)` from the local
   mirror.
4. `get(cacheKey, softTags)` consults `localTagTimestamps` and treats the
   entry as stale if any soft tag was invalidated after `entry.timestamp`.

The reference implementation in next-redis-cache-demo measured **6.4 ms**
mean propagation across two ECS tasks under sustained load with this
exact pattern.

## Memory fallback

The fallback path mirrors Redis semantics but exists to keep the app up
when Redis is unreachable. It is **per-process**, so multi-instance
correctness degrades to per-instance correctness.

`MemoryStore<T>` and `MemorySetStore` use `setTimeout(..., ttl*1000)` with
two safeguards:
- `unref()` so a pending timer doesn't keep the process alive on SIGTERM
- 32-bit timer clamp (`MAX_TIMER_MS = 2^31-1`) — `cacheLife({expire:
  Infinity})` resolves to a 1-year TTL which exceeds Node's signed
  setTimeout limit

The `expiresAt` check in `get()` handles entries whose timer was clamped.

## Why we don't ship a stampede / single-flight lock yet

`v0.1` does not implement Lua single-flight locking around stale →
background-refresh. Reasons:

1. Next.js 16 already serializes per-cacheKey background refresh
   internally on each instance. The marginal benefit at our target scale
   is small.
2. Adding a Redis lock introduces a partial-failure mode (lock acquired,
   refresh crashed, lock TTL has to elapse before recovery) that needs
   careful tuning.
3. The Lua script `refresh-tag-lock.lua` is bundled and tested in this
   release. The handler logic to consume it ships in **v0.2**.
