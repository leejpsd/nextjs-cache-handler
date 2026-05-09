# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-05-10

Documentation-only patch released alongside the first round of external
write-ups. No code changes.

### Changed

- **Compatibility matrix** now carries an explicit verification date and a
  `nextjs-turbo-redis-cache` column, so readers can spot-check the comparison
  against the upstream READMEs as both packages evolve. The previous
  two-column shape didn't make it obvious which competitors are tracked.
- **Production checklist** gains an explicit Redis Cluster row: cluster
  deployments must set `hashTag: true` to avoid `CROSSSLOT` errors from
  the multi-key Lua scripts. Also notes that cluster support is
  unit-tested but not yet load-tested at scale.
- **Compatibility table for Redis-protocol services** (ElastiCache,
  Upstash, DragonflyDB, KeyDB, Vercel KV) added to the production
  section, separating "validated" from "expected to work via the
  standard Redis protocol".
- **`docs/architecture.md`** now documents two memory-fallback caveats
  that previously required reading the source: per-process isolation
  (cross-instance correctness degrades during Redis outages) and the
  32-bit `setTimeout` clamp (TTLs above ≈24.85 days fire the eviction
  timer early, though `get()`'s lazy `expiresAt` check still honors the
  configured expiration).

## [0.1.0] - 2026-05-10

First stable release. Promoted from `0.1.0-rc.1` after a 24-hour live-traffic
soak on AWS ECS Fargate (multi-instance, ElastiCache Redis): 0 errors, 0
entry leaks, Redis ping stable at 2ms, namespace isolation confirmed in
runtime cache key shapes.

### Verified during dogfood

- Library wrapper modules require'd successfully on every staging task
  (CloudWatch `[lib-incremental]` / `[lib-cache-components]` startup
  signals)
- Cache entries written with `BUILD_NAMESPACE` prefix
  (`next-cache:entry:<sha>:...`) — confirms deployment isolation
- `revalidateAccepted: 1` round-trip latency 193ms across the ALB; Server
  Action `revalidateTag` propagates without errors
- Static chunks resolve 200 across both `/dashboard` and `/experiments`
  routes — the static-chunk-404 incident remediation is live

### Pre-1.0 caveats

- Released under 0.1.x — APIs may receive small adjustments before 1.0
- Single-flight refresh lock is bundled (`refresh-tag-lock.lua`) but the
  handler-side wiring lands in v0.2
- Provenance attestation is disabled for the local-publish flow; v0.2
  will switch to GitHub Actions OIDC publish



### Added — `cacheHandlers` (plural) for `'use cache'`

- `createCacheComponentsHandler(opts)` factory implementing the full
  Next.js 16 spec: `get`, `set`, `refreshTags`, `getExpiration`,
  `updateTags`
- 3-axis stale-while-revalidate partition (fresh / stale / expired)
- Lua-atomic `SET entry + SADD tag + EXPIRE tag` via `set-with-tags.lua`
- Lua-atomic hard invalidation via `revalidate-hard.lua`
- Soft-tag freshness check (per spec § 2.3)
- ReadableStream serialization to base64 envelopes

### Added — `cacheHandler` (singular) for ISR / Pages Router

- `createIncrementalCacheHandler(opts)` factory returning a class
  compatible with `next.config.ts#cacheHandler`
- Buffer/Map JSON serialization preserved across Redis round-trip
- Tag-state model with separate `stale` (FETCH-only) and `expired`
  semantics
- `instance-local:*` tag prefix bypasses Redis (per-instance cache)

### Added — Shared infrastructure

- `BUILD_NAMESPACE` automatic deployment isolation
  (`DEPLOYMENT_VERSION` ?? `GIT_HASH` ?? `unversioned`)
- `withAbortSignal` timeout wrapper (default 1500ms; `CacheTimeoutError`)
- Build-phase skip via `process.env.NEXT_PHASE === "phase-production-build"`
  detection — fixes PR #207 root cause
- TTL-aware in-memory fallback with 32-bit `setTimeout` clamp
- `RedisClientLike` adapters: `redis@5`, `ioredis`, `ioredis.Cluster`
- `EVALSHA` with `EVAL` fallback on `NOSCRIPT`
- Process-local metric counters with optional `onMetric` emit hook
- Configurable cluster-safe `hashTag` mode

### Build / publish

- ESM + CJS dual publish via `tsup`
- 6 entry points: `.`, `/cache-components`, `/incremental`,
  `/client/redis`, `/client/ioredis`, `/ops`
- `arethetypeswrong` 100% green across `node10`, `node16` (CJS), `node16`
  (ESM), `bundler`
- `publint` clean
- 66 unit tests covering build-phase skip, SWR, abort, memory fallback,
  serialization, and both handlers end-to-end
