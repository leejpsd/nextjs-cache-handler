# Day 1 Dogfood Report

> Date: 2026-05-05
> Library version: v0.0.0 (pre-release)
> Demo project: `/Users/jungpyo/workspace/next-redis-cache-demo`

## Goal

Validate that `@leejpsd/nextjs-cache-handler` v0.0.0 can replace the demo
project's in-tree `redis-handler.ts` and `incremental-cache-handler.js`
with no regression and no Redis required at build time.

## Setup

1. `npm link @leejpsd/nextjs-cache-handler` from the demo project (symlinked
   into `node_modules/@leejpsd/nextjs-cache-handler`).
2. Added two CJS wrapper files in the demo:
   - `lib-cache-components.cjs` — calls `createCacheComponentsHandler({...})`
   - `lib-incremental-cache-handler.cjs` — calls `createIncrementalCacheHandler({...})`
3. Patched `next.config.ts` with a `USE_LIBRARY_HANDLER=true` env toggle that
   swaps which file `cacheHandler` / `cacheHandlers.default` resolve to.

The original handlers are untouched; one env var is the rollback path.

## Results

### ✅ `next build` with `USE_LIBRARY_HANDLER=true`, no Redis

```
$ DISABLE_REDIS_CACHE_HANDLER=true USE_LIBRARY_HANDLER=true npm run build
✓ Generating static pages using 9 workers (25/25) in 821ms
```

All 25 routes prerender successfully. Build-phase skip works exactly as
designed — the library wrapper detects `NEXT_PHASE=phase-production-build`
and short-circuits Redis. **This is the precise scenario that left
`@fortedigital/nextjs-cache-handler` PR #207 stalled.**

### ✅ `next build` with `USE_LIBRARY_HANDLER=true`, Redis URL set

```
$ REDIS_URL=redis://localhost:6379 USE_LIBRARY_HANDLER=true npm run build
```

Build still succeeds even though Redis is unreachable on `localhost:6379`,
because build-phase skip ignores `REDIS_URL`. No `ECONNREFUSED` from the
library handlers.

### ✅ Demo test suite

```
$ npm test
Test Files  9 passed (9)
     Tests  34 passed (34)
   Duration 835ms
```

No regression vs the in-tree handlers.

### ✅ End-to-end wire test (memory fallback)

In-process exercise of all 5 + 4 spec methods via the wrappers (no Redis):

**cacheHandlers (plural, `'use cache'`):**
- `set(cacheKey, pendingEntry)` ✅
- `get(cacheKey, softTags)` round-trips `Buffer→ReadableStream→Buffer` ✅
- `updateTags(['t1'])` (soft) ✅
- `getExpiration(['t1'])` returns the timestamp ✅
- `updateTags(['t1'], { expire: 0 })` (hard) ✅
- `refreshTags()` ✅

**cacheHandler (singular, ISR):**
- `set(key, data, ctx)` stores APP_PAGE entry ✅
- `get(key, ctx)` HIT returns the entry with `lastModified` and tags ✅
- `revalidateTag('posts', { expire: 0 })` (hard) ✅
- post-invalidate `get()` returns null ✅
- `resetRequestCache()` ✅

## Issues found and fixed

- **`setTimeout(..., 31536000000)` overflow warning** — `cacheLife({expire:
  Infinity})` can produce a 1-year TTL which exceeds Node's signed 32-bit
  setTimeout limit. Patched `MemoryStore` and `MemorySetStore` to clamp
  scheduled timers at `MAX_TIMER_MS = 2_147_483_647` (~24.85 days) and rely
  on the lazy `expiresAt` check in `get()` for anything beyond.

## Verification command summary

For future dogfood iterations:

```bash
cd /Users/jungpyo/workspace/next-redis-cache-demo

# Smoke 1: build with library + no Redis (validates build-phase skip)
DISABLE_REDIS_CACHE_HANDLER=true USE_LIBRARY_HANDLER=true npm run build

# Smoke 2: build with library + Redis URL (validates skip even when env present)
REDIS_URL=redis://localhost:6379 USE_LIBRARY_HANDLER=true npm run build

# Smoke 3: existing demo unit tests stay green
npm test

# Wire 1: in-process round-trip via wrapper (no Redis)
node -e "process.env.CACHE_HANDLER_FALLBACK='memory';
  const h = require('./lib-cache-components.cjs');
  // ... 5 spec method exercise
"

# Rollback: drop USE_LIBRARY_HANDLER
unset USE_LIBRARY_HANDLER && npm run build  # reverts to in-tree handlers
```

## Verdict

The library is **functionally compatible** with the in-tree handlers under
both build-phase and memory-fallback paths. Live Redis dogfood (multi-task
ECS, revalidateTag propagation latency, soak) is the remaining check, and
that requires the demo's staging environment.

Next: Phase 2 work (Redis-backed integration tests) or Phase 3 work
(README/CI/publish prep).
