# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
